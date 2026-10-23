import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sessionDirectory, sessionOutputPath } from './session-output.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { inspectWorkspace } from '../eval/workspace-preflight.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function command(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('\0')), 'Commands must be nonempty argv arrays');
}
function validate(profile) {
  requireValue(profile && typeof profile === 'object', 'Execution profile is missing');
  command(profile.command);
  requireValue(Array.isArray(profile.required_env) && profile.required_env.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)), 'required_env must list environment variable names');
  requireValue(Array.isArray(profile.config_inputs) && profile.config_inputs.length > 0, 'config_inputs must include the actual execution configuration sources');
  for (const file of profile.config_inputs) requireValue(typeof file === 'string' && file && !isAbsolute(file) && !file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'config_inputs must be workspace-relative files');
  requireValue(Array.isArray(profile.prepare) && Array.isArray(profile.verify_config) && profile.verify_config.length > 0, 'prepare and nonempty verify_config are required');
  [...profile.prepare, ...profile.verify_config].forEach(command);
  requireValue(Array.isArray(profile.dependencies), 'dependencies must explicitly list required infrastructure, or []');
  for (const dependency of profile.dependencies) {
    requireValue(ID.test(dependency.id), 'Dependency id is required');
    command(dependency.check);
  }
  for (const key of ['timeout_ms', 'readiness_timeout_ms', 'poll_interval_ms']) requireValue(Number.isSafeInteger(profile[key]) && profile[key] > 0 && profile[key] <= 43_200_000, `${key} must be 1..43200000`);
}

export async function readExecutionManifest(root) {
  const path = 'docs/agents/execution.json';
  await assertWorkspaceTarget(root, path);
  const text = await readFile(join(root, path), 'utf8');
  const manifest = JSON.parse(text);
  requireValue(manifest.schema_version === 1, 'Unsupported execution contract version');
  requireValue(manifest.profiles && typeof manifest.profiles === 'object' && !Array.isArray(manifest.profiles) && Object.keys(manifest.profiles).length > 0, 'Execution contract must contain profiles');
  for (const [id, profile] of Object.entries(manifest.profiles)) {
    requireValue(ID.test(id), 'Invalid execution profile id');
    validate(profile);
  }
  return { manifest, text };
}
function expand(argv, env) {
  return argv.map((item) => item.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    requireValue(typeof env[key] === 'string' && env[key].trim(), `Missing required environment value: ${key}`);
    return env[key];
  }));
}
async function fingerprint(root, files) {
  const hashes = {};
  for (const file of files) {
    requireValue(typeof file === 'string' && file && !isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'config_inputs must be workspace-relative files');
    const path = await realpath(resolve(root, file));
    const rel = relative(root, path);
    requireValue(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Configuration source escapes workspace');
    hashes[file] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return JSON.stringify(hashes);
}
async function execute(argv, { root, env, path, timeout, signal }) {
  signal?.throwIfAborted();
  const log = await open(path, 'a', 0o600);
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: root, env, stdio: ['ignore', log.fd, log.fd], detached: process.platform !== 'win32' });
      let timer, forceTimer, stopped = false;
      const kill = (name) => { if (!child.pid) return; try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const stop = () => { if (stopped) return; stopped = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 1000); };
      const abort = () => stop();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(stop, timeout);
      if (signal?.aborted) stop();
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort);
        // Foreground recipes must keep descendants attached; detached daemons need their own explicit profiles.
        kill('SIGKILL');
        if (signal?.aborted) reject(signal.reason || new Error('Execution aborted'));
        else if (stopped) reject(new Error('Execution timed out'));
        else resolveResult(code);
      });
    });
  } finally { await log.close(); }
}

export async function runExecution({ workspace_root, profile_id, environment = process.env, signal } = {}) {
  requireValue(isAbsolute(workspace_root || '') && ID.test(profile_id || ''), 'Absolute workspace_root and profile_id are required');
  const root = await realpath(workspace_root);
  const workspace = await inspectWorkspace({ workspaceRoot: root, cwd: process.cwd() });
  requireValue(workspace.valid, `Workspace preflight failed: ${workspace.reason}`);
  const directory = sessionOutputPath(root, `runtime/execution/${profile_id}-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const receipt = { profile_id, status: 'blocked', phase: 'load', steps: [], config_hashes: null };
  try {
    const manifestPath = 'docs/agents/execution.json';
    const { manifest, text: manifestText } = await readExecutionManifest(root);
    const profile = manifest.profiles?.[profile_id];
    validate(profile);
    const temporary = sessionOutputPath(root, 'tmp');
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const env = { ...environment, HARNESS_SESSION_DIR: sessionDirectory(root), HARNESS_EXECUTION_DIR: directory, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    for (const key of profile.required_env) requireValue(typeof env[key] === 'string' && env[key].trim(), `Missing required environment value: ${key}`);
    // Resolve every command before side effects, including parameters used only by a later readiness check.
    const prepare = profile.prepare.map((argv) => expand(argv, env));
    const verify = profile.verify_config.map((argv) => expand(argv, env));
    const dependencies = profile.dependencies.map((item) => ({ id: item.id, argv: expand(item.check, env) }));
    const main = expand(profile.command, env);
    const inputs = [...new Set([manifestPath, ...profile.config_inputs])];
    for (const file of inputs) {
      requireValue(typeof file === 'string' && file && !isAbsolute(file) && !file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'config_inputs must be workspace-relative files');
      await assertWorkspaceTarget(root, file);
    }
    const step = async (phase, argv, timeout = profile.readiness_timeout_ms) => {
      receipt.phase = phase;
      const path = sessionOutputPath(root, relative(sessionDirectory(root), join(directory, `${receipt.steps.length}.log`)));
      const code = await execute(argv, { root, env, path, timeout, signal });
      receipt.steps.push({ phase, exit_code: code, log: path });
      return code;
    };
    for (const argv of prepare) requireValue(await step('prepare', argv) === 0, 'Configuration preparation failed');
    requireValue(await readFile(join(root, manifestPath), 'utf8') === manifestText, 'Execution contract changed during preparation; rerun');
    const snapshot = await fingerprint(root, inputs);
    receipt.config_hashes = JSON.parse(snapshot);
    for (const argv of verify) requireValue(await step('verify_config', argv) === 0, 'Configuration verification failed');
    for (const dependency of dependencies) {
      const deadline = Date.now() + profile.readiness_timeout_ms;
      let ready = false;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        ready = await step(`dependency:${dependency.id}`, dependency.argv, remaining) === 0;
        if (ready) break;
        await delay(Math.min(profile.poll_interval_ms, Math.max(0, deadline - Date.now())), undefined, { signal });
        signal?.throwIfAborted();
      } while (Date.now() < deadline);
      requireValue(ready, `Infrastructure is not ready: ${dependency.id}`);
    }
    requireValue(await fingerprint(root, inputs) === snapshot, 'Configuration changed during preflight; rerun with current settings');
    receipt.exit_code = await step('command', main, profile.timeout_ms);
    receipt.status = receipt.exit_code === 0 ? 'passed' : 'failed';
  } catch (error) { receipt.status = signal?.aborted ? 'interrupted' : receipt.phase === 'command' ? 'failed' : 'blocked'; receipt.error = error.message; }
  finally { await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); }
  return { ...receipt, evidence_path: join(directory, 'receipt.json'), session_directory: sessionDirectory(root) };
}
