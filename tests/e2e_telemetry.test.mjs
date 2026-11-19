import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const guide = '.codex/internal-skills/e2e-telemetry/GUIDE.md';
const script = '.codex/internal-skills/e2e-telemetry/scripts/report.mjs';
const main = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const missing = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-19T00:00:00.000Z';
const earlier = '2026-11-18T00:00:00.000Z';
const event = (type, payload, timestamp = now) => ({ type, payload, timestamp });
const tokens = (id, response_id, input_tokens, timestamp) => event('token_usage_record', {
  thread_id: id, response_id, usage: { input_tokens, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
}, timestamp);
const call = (call_id, name, cmd = '') => event('response_item', { type: 'function_call', name, call_id, arguments: JSON.stringify({ cmd }) });
const output = (call_id, text) => event('response_item', { type: 'function_call_output', call_id, output: text });
const compaction = (thread_id, id, timestamp) => event('event_msg', { type: 'item_completed', thread_id, turn_id: 'stage-turn', item: { type: 'ContextCompaction', id } }, timestamp);

test('installed E2E telemetry switches off cleanly and counts observed roots and subagents without copying tool content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'consumer'), codexHome = join(dir, 'codex');
  const sessions = join(codexHome, 'sessions', '2026', '11', '19');
  await mkdir(root);
  await mkdir(sessions, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const rollout = (id, entries) => writeFile(join(sessions, 'rollout-example-' + id + '.jsonl'), entries.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const included = tokens(main, 'first', 10);
  await rollout(main, [
    event('session_meta', { id: main }),
    tokens(main, 'outside', 99, earlier), included, included,
    event('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 999 } } }),
    event('event_msg', { type: 'item_completed', thread_id: main, item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: child } }, earlier),
    event('event_msg', { type: 'item_completed', thread_id: main, item: { type: 'SubAgentActivity', kind: 'interacted', agent_thread_id: child } }),
    compaction(main, 'old-compaction', earlier),
    event('compacted', { message: 'CANARY_PRIVATE_SUMMARY' }),
    compaction(main, 'main-compaction'), compaction(main, 'main-compaction'),
    call('1', 'exec_command', 'cat CANARY_PRIVATE_PATH'),
    output('1', 'cat: CANARY_PRIVATE_PATH: No such file or directory'),
    call('2', 'exec_command', 'rg --files docs'),
    call('3', 'exec_command', 'npm test'),
    call('4', 'exec_command', 'npm test'),
    call('5', 'list_agents'), output('5', 'unchanged'),
    call('6', 'list_agents'), output('6', 'unchanged'),
  ]);
  await rollout(child, [
    event('session_meta', { id: child, parent_thread_id: main }),
    compaction(main, 'main-compaction'), compaction(child, 'own-compaction'), tokens(child, 'child', 4),
  ]);
  const run = (enabled, id, extra = []) => JSON.parse(execFileSync(process.execPath, [
    join(root, script), '--root', root, '--run-id', id, ...extra,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, HARNESS_E2E_TELEMETRY: enabled, CODEX_HOME: codexHome } }));
  const reportPath = (id) => join(root, '.io/runtime/e2e', id, 'telemetry.json');

  assert.deepEqual(run('0', 'off', ['--thread', 'intentionally-invalid']), { status: 'disabled' });
  await assert.rejects(readFile(reportPath('off')), { code: 'ENOENT' });
  assert.equal(run('1', 'unobserved').status, 'unavailable');
  assert.equal(run('1', 'usage', ['--thread', main, '--thread', main, '--since', now]).status, 'complete');
  const reportText = await readFile(reportPath('usage'), 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.threads.length, 2);
  assert.deepEqual(report.tokens, { input_tokens: 14, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2 });
  assert.equal(report.calls, 6);
  assert.equal(report.compactions, 2);
  assert.equal(report.threads[0].compactions.length, 1);
  assert.deepEqual(report.threads[1].compactions, [{ line: 3, turn_id: 'stage-turn', at: now }]);
  assert.deepEqual(report.candidates, { read: 1, missing_path: 1, search: 1, test: 2, repeated_command: 1, unchanged_agent_list: 1 });
  assert.doesNotMatch(reportText, /CANARY_PRIVATE_PATH|CANARY_PRIVATE_SUMMARY|npm test/);
  assert.equal(run('1', 'partial', ['--thread', main, '--thread', missing]).status, 'partial');
  assert.equal(JSON.parse(await readFile(reportPath('partial'), 'utf8')).missing[0].thread_id, missing);
  const invalid = spawnSync(process.execPath, [join(root, script), '--root', root, '--run-id', '../outside'], {
    env: { ...process.env, HARNESS_E2E_TELEMETRY: '1' }, encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);

  await writeFile(join(root, 'app.txt'), 'project change\n');
  for (const path of [script, guide]) await unlink(join(root, path));
  const diagnostics = (await runDoctor({ root, sourceRoot })).diagnostics;
  for (const path of [script, guide]) assert.ok(diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith(path)));
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(run('1', 'updated', ['--thread', main]).status, 'complete');
  assert.match(await readFile(join(root, '.codex/internal-skills/e2e-test/GUIDE.md'), 'utf8'), /HARNESS_E2E_TELEMETRY=1/);
  for (const path of [guide, script, '.io/runtime/e2e/updated/telemetry.json', '.io/runtime/e2e/updated/telemetry.md']) git('check-ignore', '-v', path);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '?? app.txt');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'project change\n');
});
