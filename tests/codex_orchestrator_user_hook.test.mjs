import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCodexHookTrust, syncCodexSubagentHook, codexSubagentHook } from '../.codex/harness/providers/codex.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const startupEvents = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const unrelated = { type: 'command', command: 'project-hook' };
const groups = (...hooks) => [{ hooks }];

test('Codex user migration retires only the old startup hook and backs up the original', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-user-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = join(root, 'account');
  await mkdir(account);
  const env = { CODEX_HOME: account };
  const old = { type: 'command', command: `sh -c 'r=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; f="$r/.codex/scripts/harness-orchestrator-hook.mjs"; [ -f "$f" ] || exit 0; grep -qs harness-orchestrator-hook.mjs "$r/.codex/hooks.json" && exit 0; exec node "$f"'`, statusMessage: 'Running Harness orchestrator hook', timeout: 10 };
  const hooks = Object.fromEntries(startupEvents.map((event) => [event, [...groups(old), ...groups(unrelated)]]));
  hooks.SubagentStart = groups(codexSubagentHook());
  hooks.SubagentStop = groups(codexSubagentHook());
  const path = join(root, 'hooks.json'), config = join(root, 'config.toml');
  const original = JSON.stringify({ hooks });
  await writeFile(path, original);
  await writeFile(config, '# keep trust settings\n');
  await symlink(path, join(account, 'hooks.json'));
  assert.equal((await inspectCodexHookTrust(env)).retired_startup, true);
  assert.equal((await syncCodexSubagentHook(env, { retireStartupOnly: true })).changed, true);
  assert.equal((await inspectCodexHookTrust(env)).retired_startup, false);
  assert.equal((await lstat(join(account, 'hooks.json'))).isSymbolicLink(), true);
  const migrated = (await json(path)).hooks;
  for (const event of startupEvents) assert.deepEqual(migrated[event], [...groups(), ...groups(unrelated)]);
  for (const event of ['SubagentStart', 'SubagentStop']) assert.deepEqual(migrated[event], hooks[event]);
  const backup = (await readdir(root)).find((name) => name.startsWith('hooks.json.harness-backup-'));
  assert.equal(await readFile(join(root, backup), 'utf8'), original);
  assert.equal(await readFile(config, 'utf8'), '# keep trust settings\n');
  assert.equal((await syncCodexSubagentHook(env, { retireStartupOnly: true })).changed, false);
});

test('installed consumers retire the old startup scripts and registrations while keeping project files visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-startup-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const codexSettings = join(root, '.codex/hooks.json');
  const claudeSettings = join(root, '.claude/settings.local.json');
  const runtime = '.harness/scripts/harness-context.mjs';
  const retired = ['.codex/scripts/harness-orchestrator-hook.mjs', '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs'];
  assert.equal(existsSync(codexSettings), false);
  for (const path of retired) assert.equal(existsSync(join(root, path)), false);
  const originalClaude = await json(claudeSettings);
  for (const event of startupEvents) assert.equal(originalClaude.hooks[event], undefined);

  const script = '// Previous managed script\n';
  const hash = createHash('sha256').update(script).digest('hex');
  const lockPath = join(root, '.harness/harness-lock.json'), lock = await json(lockPath);
  for (const path of retired) {
    await writeFile(join(root, path), script);
    lock.files[path] = { source_path: path, installed_sha256: hash, upstream_sha256: hash };
  }
  await writeFile(lockPath, JSON.stringify(lock));
  const codexOld = { type: 'command', command: `node "${join(root, retired[0])}"`, statusMessage: 'Preparing Harness workflow composition', timeout: 10 };
  const claudeOld = { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.claude/harness/scripts/harness-claude-orchestrator-hook.mjs"', timeout: 10 };
  await writeFile(codexSettings, JSON.stringify({ hooks: Object.fromEntries(startupEvents.map((event) => [event, groups(codexOld, unrelated)])) }));
  await writeFile(claudeSettings, JSON.stringify({ ...originalClaude, hooks: { ...originalClaude.hooks, ...Object.fromEntries(startupEvents.map((event) => [event, groups(claudeOld, unrelated)])) } }));
  await mkdir(join(root, '.harness/agents'), { recursive: true });
  await writeFile(join(root, '.harness/agents/EXEC.md'), 'project owned\n');
  await writeFile(join(root, 'app.txt'), 'application owned\n');
  assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code }) => code === 'retired_orchestrator_hook'));

  const update = await updateProject({ sourceRoot, targetRoot: root });
  for (const path of retired) {
    assert.ok(update.retired.includes(path));
    assert.equal(existsSync(join(root, path)), false);
  }
  const migratedCodex = await json(codexSettings), migratedClaude = await json(claudeSettings);
  for (const event of startupEvents) {
    assert.deepEqual(migratedCodex.hooks[event], groups(unrelated));
    assert.deepEqual(migratedClaude.hooks[event], groups(unrelated));
  }
  for (const event of ['SubagentStart', 'SubagentStop', 'PreToolUse']) {
    assert.deepEqual(migratedClaude.hooks[event], originalClaude.hooks[event]);
  }
  const doctor = await runDoctor({ root, sourceRoot });
  assert.deepEqual(doctor.diagnostics.filter(({ code }) => ['execution_asset_missing', 'retired_orchestrator_hook', 'orchestrator_hook_missing', 'claude_orchestrator_hook_missing'].includes(code)), []);
  assert.equal(git('status', '--short', '--untracked-files=all'), '?? .harness/agents/EXEC.md\n?? app.txt\n');
  assert.equal(await readFile(join(root, '.harness/agents/EXEC.md'), 'utf8'), 'project owned\n');
  for (const path of [runtime, '.codex/hooks.json', '.claude/settings.local.json', '.io/runtime/orchestrator/state.json']) git('check-ignore', '-v', path);
});
