import { dirname, join, resolve } from 'node:path';
import { mkdir, realpath, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCodexProcess } from '../codex-process.mjs';
import { parseYaml } from '../../eval/yaml.mjs';

export const id = 'codex';

export async function resumeWriteDirs(sessionId, env) {
  const home = resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));
  const sessionRoot = join(home, 'sessions');
  const dirs = new Set();
  async function findSession(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await findSession(path);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return dirname(path);
    }
    return null;
  }
  const sessionDir = await findSession(await realpath(sessionRoot));
  if (!sessionDir) throw new Error(`Codex resume session file not found under ${sessionRoot}: ${sessionId}`);
  dirs.add(await realpath(sessionDir));
  for (const path of ['thread-writer-locks', 'shell_snapshots', 'tmp/arg0', 'tmp/arg0-linux']) {
    try { dirs.add(await realpath(join(home, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...dirs];
}

export async function buildCommand({ root, sandbox, resumeWriteDirs: dirs, binding, schemaPath, output, resume, role, skill, env = process.env }) {
  const config = ['implement-wrapper', 'implement'].includes(skill) ? parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')) : {};
  const githubTracker = skill === 'implement-wrapper' && config.tracker?.mode === 'github';
  if (sandbox === 'workspace-write' && config.beads?.enabled === true) {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    const gitCommonDir = await realpath(resolve(root, stdout.trim()));
    dirs = [...new Set([...dirs, dirname(gitCommonDir), gitCommonDir])];
  }
  return ['exec', '--sandbox', sandbox, ...dirs.flatMap((path) => ['--add-dir', path]), '--cd', root, '--model', binding.model,
    ...await stageConfigArgs(env, [join(root, '.codex/config.toml')], role, skill), ...(githubTracker && sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--enable', 'multi_agent', '--json',
    '--output-schema', schemaPath, '--output-last-message', output, ...(resume ? ['resume', resume, '-'] : ['-'])];
}

function mcpServerName(line) {
  const section = /^\[mcp_servers\.(.+?)\](?:\s*#.*)?$/.exec(line.trim())?.[1];
  if (!section) return null;
  if (section[0] === '"' || section[0] === "'") return section.slice(1, section.indexOf(section[0], 1));
  return section.split('.')[0];
}

export async function stageConfigArgs(env = process.env, configPaths = [], role = null, skill = null) {
  const paths = [resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'), 'config.toml'), ...configPaths];
  const configs = await Promise.all(paths.map((path) => readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })));
  const servers = [...new Set(configs.flatMap((config) => config.split('\n').map(mcpServerName).filter(Boolean)))];
  const frontend = ['frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer'].includes(role);
  const research = skill === 'spec-me' || ['spec_document_writer', 'code_researcher', 'architecture_review_lead', 'spec_adversarial_reviewer', 'knowledge_source_researcher', 'knowledge_principle_synthesizer', 'frontend_designer'].includes(role);
  const visual = frontend || role === 'diagram_creator' || role === 'spec_adversarial_reviewer' || skill === 'spec-me';
  const imageGeneration = frontend || skill === 'frontend-design';
  const retained = frontend ? new Set(['figwright', 'iconify', 'awwwards']) : new Set();
  const disabledServers = servers.filter((server) => !retained.has(server));
  return ['-c', 'skills.include_instructions=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.goals=false', '-c', `features.image_generation=${imageGeneration ? 'true' : 'false'}`, '-c', `features.view_image=${visual ? 'true' : 'false'}`, '-c', `web_search=${JSON.stringify(research ? 'live' : 'disabled')}`, '-c', `model_instructions_file=${JSON.stringify(resolve(fileURLToPath(new URL('../../../..', import.meta.url)), '.codex/internal-skills/skill-execution/worker-base.md'))}`,
    ...(disabledServers.length ? ['-c', `mcp_servers={${disabledServers.map((server) => `${JSON.stringify(server)}={enabled=false}`).join(',')}}`] : [])];
}

export async function run({ root, args, prompt, env, onStart, onSession, onEvent, onStderr, onCodexError }) {
  const result = await runCodexProcess({ root, args, prompt, env, onStart, onEvent, onStderr, onCodexError, onThread: onSession });
  return { ...result, sessionId: result.threadId };
}

const snake = (event) => event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`);
const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'];
const SUBAGENT_STATUS = 'Recording Harness subagent';
const codexHome = (env) => resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));

// One user-level hook serves every project and worktree: it runs the active workspace's
// harness-agent-event.mjs only inside a Harness stage and does nothing elsewhere.
export function codexSubagentHook() {
  return {
    type: 'command',
    command: `sh -c '[ -n "$HARNESS_SKILL_EXECUTION_ID" ] && [ -f "$HARNESS_WORKSPACE_ROOT/.codex/scripts/harness-agent-event.mjs" ] && exec node "$HARNESS_WORKSPACE_ROOT/.codex/scripts/harness-agent-event.mjs"; exit 0'`,
    statusMessage: SUBAGENT_STATUS,
    timeout: 10,
  };
}

export async function syncCodexSubagentHook(env = process.env) {
  const path = join(codexHome(env), 'hooks.json');
  const text = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const config = text === null ? { hooks: {} } : JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.hooks !== undefined && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) throw new Error(`Invalid Codex hooks configuration: ${path}`);
  config.hooks ||= {};
  const expected = codexSubagentHook();
  let changed = false;
  for (const event of SUBAGENT_EVENTS) {
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const owned = groups.flatMap((group) => group.hooks || []).filter((handler) => handler?.statusMessage === SUBAGENT_STATUS);
    if (owned.length === 1 && JSON.stringify(owned[0]) === JSON.stringify(expected)) continue;
    const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((handler) => handler?.statusMessage !== SUBAGENT_STATUS) })).filter((group) => group.hooks.length);
    config.hooks[event] = [...kept, { hooks: [expected] }];
    changed = true;
  }
  if (!changed) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  if (text !== null) await writeFile(`${path}.harness-backup-${Date.now()}`, text, { flag: 'wx', mode: 0o600 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return { path, changed: true };
}

// Codex runs a hook only after the user trusts it with `/hooks`; trust is recorded in
// `$CODEX_HOME/config.toml` as `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` with a trusted hash.
export async function inspectCodexHookTrust(env = process.env) {
  const home = codexHome(env), hooksPath = join(home, 'hooks.json');
  const text = await readFile(hooksPath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const hooks = text ? JSON.parse(text).hooks || {} : {};
  const config = await readFile(join(home, 'config.toml'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const trusted = new Set();
  let current = null;
  for (const line of config.split('\n')) {
    const header = /^\s*\[hooks\.state\."(.+)"\]\s*$/.exec(line);
    if (header) { current = header[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (current && /^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]{64}"/.test(line)) trusted.add(current);
  }
  const missing = [], untrusted = [];
  for (const event of SUBAGENT_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const slots = groups.flatMap((group, groupIndex) => (group.hooks || []).map((handler, handlerIndex) => ({ handler, key: `${hooksPath}:${snake(event)}:${groupIndex}:${handlerIndex}` }))).filter(({ handler }) => handler?.statusMessage === SUBAGENT_STATUS);
    if (!slots.length) missing.push(event);
    else if (!slots.some(({ key }) => trusted.has(key))) untrusted.push(event);
  }
  return { trusted: !missing.length && !untrusted.length, missing, untrusted, hooks_path: hooksPath };
}
