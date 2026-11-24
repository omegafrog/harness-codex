import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexFreshAgentHook, codexWriteGuardHook } from '../.codex/harness/providers/codex.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { HOOK_TIMING_LOG, summarizeHookTiming } from '../.harness/src/observability/hook-timing.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const telemetry = '.harness/internal-skills/e2e-telemetry/scripts/report.mjs';
const MAIN = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-19T00:00:00.000Z';
const spawnEvent = (fork) => ({ hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent', tool_input: { agent_type: 'spec_reviewer', fork_turns: fork, message: 'x' } });
const shellEvent = (root) => ({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', cwd: root, tool_input: { cmd: 'ls' } });

async function consumer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hook-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'consumer');
  await mkdir(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  return { dir, root };
}

const logRows = async (root) => (await readFile(join(root, '.io', HOOK_TIMING_LOG), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('the installed PreToolUse hooks record invocations and duration only when HARNESS_HOOK_TIMING=1, without changing a decision', async (t) => {
  const { root } = await consumer(t);
  const env = (extra = {}) => {
    const base = { ...process.env, HARNESS_WORKSPACE_ROOT: root };
    delete base.HARNESS_STAGE_EXECUTION_ID; delete base.HARNESS_HOOK_TIMING;
    return { ...base, ...extra };
  };
  // The installed hook commands are the ones whose Codex trust hash users already approved; timing never touches them.
  for (const hook of [codexFreshAgentHook(), codexWriteGuardHook()]) assert.doesNotMatch(hook.command, /TIMING|timing/, 'the timing switch is read inside the node script, not by the hook command');
  const run = (hook, event, extra) => spawnSync('sh', ['-c', hook.command], { input: JSON.stringify(event), cwd: root, encoding: 'utf8', env: env(extra) });

  const off = run(codexFreshAgentHook(), spawnEvent('all'));
  assert.equal(JSON.parse(off.stdout).hookSpecificOutput.permissionDecision, 'deny');
  run(codexWriteGuardHook(), shellEvent(root));
  assert.deepEqual(await logRows(root), [], 'nothing is recorded unless the switch is on');

  const on = run(codexFreshAgentHook(), spawnEvent('all'), { HARNESS_HOOK_TIMING: '1' });
  assert.equal(on.stdout, off.stdout, 'the decision is the same with the switch on');
  assert.equal(on.stderr, off.stderr);
  assert.equal(run(codexFreshAgentHook(), spawnEvent('none'), { HARNESS_HOOK_TIMING: '1' }).stdout, '');
  const guard = run(codexWriteGuardHook(), shellEvent(root), { HARNESS_HOOK_TIMING: '1' });
  assert.equal(guard.stdout, '');
  // A tool the installed shell filter never forwards to node starts no script and so has nothing to record.
  run(codexFreshAgentHook(), shellEvent(root), { HARNESS_HOOK_TIMING: '1' });

  const rows = await logRows(root);
  assert.deepEqual(rows.map((row) => row.hook), ['fresh-agent', 'fresh-agent', 'write-guard']);
  for (const row of rows) {
    assert.ok(Number.isFinite(row.duration_ms) && row.duration_ms >= 0 && row.duration_ms < 10_000);
    assert.ok(row.node_uptime_ms >= row.duration_ms, 'node start-up is reported apart from the script duration');
    assert.equal(row.exit_code, 0);
    assert.ok(Number.isInteger(row.pid) && Date.parse(row.started_at) > 0);
    assert.equal(row.stage_execution_id, null);
  }

  // A repository that is not a Harness workspace gets no log, and a stage execution is named in its rows.
  const elsewhere = await mkdtemp(join(tmpdir(), 'hook-timing-other-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  run(codexFreshAgentHook(), spawnEvent('none'), { HARNESS_HOOK_TIMING: '1', HARNESS_WORKSPACE_ROOT: elsewhere });
  await assert.rejects(readFile(join(elsewhere, '.io', HOOK_TIMING_LOG)), { code: 'ENOENT' });
  const claude = spawnSync(process.execPath, [join(root, '.claude/harness/scripts/harness-agent-admission.mjs')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: root, session_id: MAIN, tool_input: { subagent_type: 'general-purpose', prompt: 'x' } }), cwd: root, encoding: 'utf8',
    env: env({ HARNESS_HOOK_TIMING: '1', HARNESS_STAGE_EXECUTION_ID: 'stage-1' }),
  });
  assert.equal(claude.status, 0, claude.stderr);
  const last = (await logRows(root)).at(-1);
  assert.equal(last.hook, 'agent-admission');
  assert.equal(last.stage_execution_id, 'stage-1');

  // A missing measurement module never breaks the hook.
  await rm(join(root, '.harness/src/observability/hook-timing.mjs'));
  const broken = run(codexFreshAgentHook(), spawnEvent('all'), { HARNESS_HOOK_TIMING: '1' });
  assert.equal(broken.stdout, off.stdout);

  // Doctor names the missing measurement module, update restores it, and Git never sees the Harness files or the log.
  const missing = (await runDoctor({ root, sourceRoot })).diagnostics.filter((item) => item.code === 'execution_asset_missing').map((item) => item.path);
  assert.ok(missing.some((path) => path.endsWith('.harness/src/observability/hook-timing.mjs')));
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(JSON.parse(run(codexFreshAgentHook(), spawnEvent('all'), { HARNESS_HOOK_TIMING: '1' }).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await logRows(root)).at(-1).hook, 'fresh-agent');
  for (const path of ['.harness/src/observability/hook-timing.mjs', '.harness/src/wrapper/review-recurrence.mjs', `.io/${HOOK_TIMING_LOG}`]) execFileSync('git', ['-C', root, 'check-ignore', '-v', path]);
  assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' }).trim(), '');
});

test('hook timing is summarized per hook, optionally since a start time', () => {
  const row = (hook, duration_ms, started_at = NOW, node_uptime_ms = duration_ms + 30) => ({ hook, duration_ms, started_at, node_uptime_ms });
  const rows = [row('write-guard', 4), row('write-guard', 6), row('fresh-agent', 2), row('write-guard', 100, '2026-11-18T00:00:00.000Z'), { hook: 'broken' }, null];
  assert.deepEqual(summarizeHookTiming(rows), {
    'write-guard': { invocations: 3, total_ms: 110, max_ms: 100, max_node_uptime_ms: 130, mean_ms: 36.667 },
    'fresh-agent': { invocations: 1, total_ms: 2, max_ms: 2, max_node_uptime_ms: 32, mean_ms: 2 },
  });
  assert.deepEqual(Object.keys(summarizeHookTiming(rows, Date.parse(NOW))), ['write-guard', 'fresh-agent']);
  assert.equal(summarizeHookTiming(rows, Date.parse(NOW))['write-guard'].invocations, 2, 'a run starting later excludes earlier invocations');
});

test('E2E telemetry reports the MCP namespaces exposed per role with estimated description tokens, and says when it cannot', async (t) => {
  const { dir, root } = await consumer(t);
  const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude');
  const sessions = join(codexHome, 'sessions', '2026', '11', '19');
  await mkdir(sessions, { recursive: true });
  const line = (type, payload, timestamp = NOW) => ({ type, payload, timestamp });
  const rollout = (id, entries) => writeFile(join(sessions, `rollout-example-${id}.jsonl`), `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`);
  await rollout(MAIN, [
    line('session_meta', { id: MAIN }),
    // 'mcp__a' + 10 characters = 16 bytes = 4 tokens; 'mcp__b' alone = 6 bytes = 2 tokens.
    line('world_state', { full: true, state: { tools: { mcp__a: 'abcdefghij', mcp__b: '', clock: 'not an MCP namespace' } } }),
    line('response_item', { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [] }] }),
    line('event_msg', { type: 'item_completed', thread_id: MAIN, item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: CHILD } }),
    line('token_usage_record', { thread_id: MAIN, response_id: 'main-1', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0 } }),
  ]);
  await rollout(CHILD, [
    line('session_meta', { id: CHILD, parent_thread_id: MAIN, source: { subagent: { thread_spawn: { parent_thread_id: MAIN, agent_role: 'workflow_stage' } } } }),
    line('world_state', { full: false, state: { environments: {} } }),
    line('token_usage_record', { thread_id: CHILD, response_id: 'child-1', usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ]);
  const hooks = join(root, '.io', HOOK_TIMING_LOG);
  const run = (id, extra = []) => {
    const result = spawnSync(process.execPath, [join(root, telemetry), '--root', root, '--run-id', id, '--thread', MAIN, ...extra], { cwd: root, encoding: 'utf8', env: { ...process.env, HARNESS_E2E_TELEMETRY: '1', CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const report = async (id) => JSON.parse(await readFile(join(root, '.io/runtime/e2e', id, 'telemetry.json'), 'utf8'));

  assert.equal(run('exposure').status, 'complete');
  const first = await report('exposure');
  assert.deepEqual(first.tool_exposure_by_role.orchestrator, { status: 'recorded', threads: 1, recorded: 1, max_mcp_namespaces: 2, max_mcp_summary_estimated_tokens: 6, max_builtin_tools_estimated_tokens: first.tool_exposure_by_role.orchestrator.max_builtin_tools_estimated_tokens });
  assert.ok(first.tool_exposure_by_role.orchestrator.max_builtin_tools_estimated_tokens > 0);
  assert.deepEqual(first.tool_exposure_by_role.workflow_stage, { status: 'unavailable', threads: 1, recorded: 0, max_mcp_namespaces: null, max_mcp_summary_estimated_tokens: null, max_builtin_tools_estimated_tokens: null }, 'a role whose rollout holds no full world state is unavailable, not zero');
  const main = first.threads.find((thread) => thread.thread_id === MAIN);
  assert.deepEqual(main.tool_exposure.mcp_namespace_names, ['mcp__a', 'mcp__b']);
  assert.equal(main.tool_exposure.mcp_tool_schemas, 'unavailable', 'full MCP tool schemas are not in the rollout');
  assert.equal(first.threads.find((thread) => thread.thread_id === CHILD).tool_exposure.status, 'unavailable');
  assert.deepEqual(first.hook_timing, { status: 'not_recorded', enable: 'HARNESS_HOOK_TIMING=1', hooks: {} });
  const markdown = await readFile(join(root, '.io/runtime/e2e/exposure/telemetry.md'), 'utf8');
  assert.match(markdown, /\| orchestrator \| 1 \| 2 \| 6 \|/);
  assert.match(markdown, /\| workflow_stage \| 1 \| 수집 불가 \| 수집 불가 \| 수집 불가 \|/);
  assert.match(markdown, /HARNESS_HOOK_TIMING=1/);

  await mkdir(dirname(hooks), { recursive: true });
  await writeFile(hooks, `${[
    { hook: 'write-guard', started_at: NOW, duration_ms: 3, node_uptime_ms: 40, exit_code: 0, pid: 1 },
    { hook: 'write-guard', started_at: NOW, duration_ms: 5, node_uptime_ms: 45, exit_code: 0, pid: 2 },
    { hook: 'fresh-agent', started_at: NOW, duration_ms: 1, node_uptime_ms: 38, exit_code: 0, pid: 3 },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  run('hooks');
  const withHooks = await report('hooks');
  assert.equal(withHooks.hook_timing.status, 'recorded');
  assert.deepEqual(withHooks.hook_timing.hooks['write-guard'], { invocations: 2, total_ms: 8, max_ms: 5, max_node_uptime_ms: 45, mean_ms: 4 });
  assert.match(await readFile(join(root, '.io/runtime/e2e/hooks/telemetry.md'), 'utf8'), /hook write-guard 2회 · 합계 8ms · 평균 4ms · 최대 5ms/);

  run('later', ['--since', '2026-11-19T00:00:01.000Z']);
  assert.deepEqual((await report('later')).hook_timing.hooks, {}, 'a run that started after these invocations does not count them');

  const claudeProject = join(claudeHome, 'projects', 'project');
  await mkdir(claudeProject, { recursive: true });
  await writeFile(join(claudeProject, `${MAIN}.jsonl`), `${JSON.stringify({ type: 'assistant', sessionId: MAIN, timestamp: NOW, message: { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
  run('claude', ['--provider', 'claude-code']);
  assert.deepEqual((await report('claude')).tool_exposure_by_role, { status: 'unavailable', reason: 'claude_code_transcript_does_not_record_tool_exposure' });
});
