import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { auditExecutions, auditReadScope, classifyRead, commandPaths, declaredScope, publicAudit } from '../.harness/src/workflow/execution-audit.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const script = '.harness/scripts/harness-execution-audit.mjs';
const PLAN_SET = 'chat-feature';
const ORCHESTRATOR = '11111111-1111-4111-8111-111111111111';
const thread = (letter) => `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`;
const T = (minute) => `2026-11-21T09:${String(minute).padStart(2, '0')}:00.000Z`;

const write = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
const lines = (entries) => `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`;
const spawn = (callId, args, at) => ({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: callId, arguments: JSON.stringify(args) } });
const started = (callId, id, path, at) => ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', id: callId, agent_thread_id: id, agent_path: path } } });
const turn = (turnId, model, effort) => [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  { type: 'turn_context', payload: { turn_id: turnId, model, collaboration_mode: { settings: { reasoning_effort: effort } } } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
];
const shell = (cmd, at = T(30)) => ({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `call-${cmd.length}-${cmd.charCodeAt(0)}`, arguments: JSON.stringify({ cmd }) } });
const jsCell = (cmd, at = T(30)) => ({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `cell-${cmd.length}`, input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}}); text(r.output)` } });

async function rollout(home, id, entries) {
  await write(join(home, 'sessions', '2026', '11', '21', `rollout-2026-11-21T09-00-00-${id}.jsonl`), lines(entries));
}

function stageEntry(id, fields = {}) {
  return { status: 'completed', code: 'OK', execution_id: id, model: 'gpt-6-luna', reasoning_effort: 'medium', skill: id.split('-')[0], native_managed: true, native_agent_session_id: ORCHESTRATOR, started_at: T(1), finished_at: T(9), updated_at: T(9), ...fields };
}

async function attest(root, id, status, extra = {}) {
  await write(join(root, `.io/runtime/executions/${id}/native-attestation.jsonl`), lines([{ status, thread_id: extra.thread_id || null, source: 'codex-subagent-stop-hook', ...extra }]));
}

// A workflow whose executions cover the cases an observer must tell apart: a clean fresh run, a retry on its own fresh
// thread, a forked spawn, a thread two executions share, a wrong model, and a rollout that is missing.
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'execution-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'workspace');
  const home = process.env.CODEX_HOME;
  const [first, retry, forked, mismatch, shared, absent] = ['a', 'b', 'c', 'd', 'e', 'f'].map(thread);
  const execution = (name) => `${name}-00000000-0000-4000-8000-000000000000`;
  const spawnCall = (callId, task, type, fork, model = 'gpt-6-luna') => spawn(callId, { task_name: task, agent_type: type, fork_turns: fork, model, reasoning_effort: 'medium', message: 'x' }, T(2));
  await rollout(home, ORCHESTRATOR, [
    { type: 'session_meta', payload: { id: ORCHESTRATOR } },
    spawnCall('s1', 'analysis_first', 'workflow_stage', 'none'), started('s1', first, '/root/analysis_first', T(2)),
    spawnCall('s2', 'analysis_retry', 'workflow_stage', 'none'), started('s2', retry, '/root/analysis_retry', T(4)),
    spawnCall('s3', 'forked_stage', 'workflow_stage', 'all'), started('s3', forked, '/root/forked_stage', T(2)),
    spawnCall('s4', 'wrong_model', 'workflow_stage', 'none'), started('s4', mismatch, '/root/wrong_model', T(2)),
    spawnCall('s5', 'shared_thread', 'workflow_stage', 'none'), started('s5', shared, '/root/shared_thread', T(2)),
    spawn('s6', { task_name: 'lone_reviewer', agent_type: 'plan_reviewer', fork_turns: 'all', message: 'x' }, T(3)), started('s6', thread('9'), '/root/lone_reviewer', T(3)),
  ]);
  const child = (id, extra = {}) => [{ type: 'session_meta', payload: { id, parent_thread_id: ORCHESTRATOR, ...extra } }];
  await rollout(home, first, [...child(first), ...turn('t1', 'gpt-6-luna', 'medium')]);
  await rollout(home, retry, [...child(retry), ...turn('t1', 'gpt-6-luna', 'medium')]);
  await rollout(home, forked, [...child(forked, { forked_from_id: ORCHESTRATOR }), ...turn('t1', 'gpt-6-luna', 'medium')]);
  await rollout(home, mismatch, [...child(mismatch), ...turn('t1', 'gpt-6-sol', 'high')]);
  await rollout(home, shared, [...child(shared), ...turn('t1', 'gpt-6-luna', 'medium')]);
  await rollout(home, thread('9'), [...child(thread('9'), { forked_from_id: ORCHESTRATOR }), ...turn('t1', 'gpt-6-luna', 'medium')]);

  const names = { first: execution('stakeholder-analysis'), retry: execution('stakeholder-analysis-retry'), forked: execution('forked'), mismatch: execution('mismatch'), shared: execution('shared'), shared2: execution('shared-again'), absent: execution('absent') };
  const state = {
    schema_version: 1, orchestrator_session_id: ORCHESTRATOR, orchestrator_provider: 'codex', status: 'running',
    stages: {
      'stakeholder-analysis': stageEntry(names.retry, { skill: 'stakeholder-analysis', native_agent_id: '/root/analysis_retry', started_at: T(4), finished_at: T(8), attempts: [
        stageEntry(names.first, { skill: 'stakeholder-analysis', status: 'waiting', code: 'USER_DECISION_REQUIRED', native_agent_id: first, started_at: T(1), finished_at: T(3) }),
      ] }),
      'subdomain-candidates': stageEntry(names.forked, { skill: 'subdomain-candidates', native_agent_id: '/root/forked_stage' }),
      'event-storming': stageEntry(names.mismatch, { skill: 'event-storming', native_agent_id: mismatch }),
      'requirements-fix': stageEntry(names.shared, { skill: 'requirements-fix', native_agent_id: shared, attempts: [stageEntry(names.shared2, { skill: 'requirements-fix', status: 'failed', code: 'FAILED', native_agent_id: shared })] }),
      'bounded-context': stageEntry(names.absent, { skill: 'bounded-context', native_agent_id: thread('0') }),
      'workflow-compose': { status: 'completed', code: 'OK', execution_id: 'workflow-compose-1', skill: 'workflow-compose', finished_at: T(0) },
    },
  };
  await write(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify(state));
  await write(join(root, '.io/worktree.json'), JSON.stringify({ plan_set_id: PLAN_SET }));
  // The runner recorded the model of the completed turn for the clean runs only.
  await attest(root, names.first, 'captured', { thread_id: first });
  await attest(root, names.retry, 'captured', { thread_id: retry });
  await attest(root, names.forked, 'unavailable', { reason: 'completed_turn_metadata_missing', thread_id: forked });
  await write(join(root, `.io/runtime/executions/${names.forked}/subagents.jsonl`), lines([{ event: 'SubagentStart', agent_id: forked, agent_type: 'workflow_stage', forked: true, admitted: false }]));
  return { root, names, threads: { first, retry, forked, mismatch, shared, absent } };
}

const byExecution = (audit) => Object.fromEntries(audit.executions.map((row) => [row.execution_id, row]));

test('the audit lists every execution and retry with its thread, fork_turns, observed model and attestation, and flags what was not fresh', async (t) => {
  const { root, names, threads } = await fixture(t);
  const audit = await auditExecutions({ root });
  const rows = byExecution(audit);
  assert.equal(audit.executions.length, 8, 'every stage execution, retries included');
  assert.equal(audit.summary.retries, 2);

  const first = rows[names.first], retry = rows[names.retry];
  assert.equal(first.thread_id, threads.first);
  assert.equal(first.fork_turns, 'none');
  assert.equal(first.agent_type, 'workflow_stage');
  assert.deepEqual(first.observed, { turns: 1, models: ['gpt-6-luna'], reasoning_efforts: ['medium'] });
  assert.deepEqual(first.attestation, { status: 'captured', thread_id: threads.first, source: 'codex-subagent-stop-hook', rows: 1 });
  assert.deepEqual(first.flags, []);
  assert.equal(first.retry, false);
  assert.equal(retry.retry, true, 'the later execution of the same stage is a retry');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.thread_id, threads.retry, 'a retry that resolves by agent path owns its own fresh thread');
  assert.notEqual(retry.thread_id, first.thread_id);
  assert.deepEqual(retry.flags, []);

  assert.deepEqual(rows[names.forked].flags.sort(), ['attestation_not_captured', 'forked_transcript', 'hook_recorded_forked_subagent', 'not_fresh']);
  assert.equal(rows[names.forked].fork_turns, 'all');
  assert.deepEqual(rows[names.forked].forked_from_id, ORCHESTRATOR);
  assert.deepEqual(rows[names.forked].attestation.reason, 'completed_turn_metadata_missing');

  assert.ok(rows[names.mismatch].flags.includes('model_mismatch'), 'turns that ran on another model or effort than requested are flagged');
  assert.deepEqual(rows[names.mismatch].observed.models, ['gpt-6-sol']);
  assert.ok(rows[names.mismatch].flags.includes('attestation_not_captured'), 'no attestation was recorded for it');

  for (const id of [names.shared, names.shared2]) assert.ok(rows[id].flags.includes('thread_reused'), 'two executions on one thread did not start fresh');
  assert.deepEqual(rows[names.shared].thread_shared_with, [names.shared2]);

  assert.ok(rows[names.absent].flags.includes('thread_unresolved') || rows[names.absent].flags.includes('rollout_unavailable'));
  assert.equal(rows['workflow-compose-1'].observation, 'not_native', 'a stage that ran in the main session is listed but not judged');
  assert.equal(audit.status, 'partial', 'a missing rollout makes the audit partial rather than silently complete');

  assert.deepEqual(audit.other_spawns.map((item) => [item.agent_type, item.flags]), [['plan_reviewer', ['not_fresh']]], 'a spawn no stage owns is checked for freshness too');
  assert.ok(audit.summary.flagged >= 4);
  assert.equal(audit.summary.flags.not_fresh, 1);
  assert.equal(publicAudit(audit)._threads, undefined, 'the transcript graph is not part of the report');
});

test('the audit marks a second ticket of the same stage as a new ticket, not a retry', async (t) => {
  const { root, names } = await fixture(t);
  const statePath = join(root, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  // tactical-code runs once per ticket: the earlier attempt of ticket P1 and the current execution of ticket P2.
  const impl = (id) => stageEntry(id, { skill: 'tactical-code', native_managed: false });
  state.stages['tactical-code'] = { ...impl('tactical-code-p2'), attempts: [impl('tactical-code-p1')] };
  await writeFile(statePath, JSON.stringify(state));
  for (const [id, plan] of [['tactical-code-p1', 'p1'], ['tactical-code-p2', 'p2']]) await write(join(root, `.io/${PLAN_SET}/tactical-code/${id}/input.json`), JSON.stringify({ execution_id: id, skill: 'tactical-code', context: { plan_id: plan } }));
  const rows = byExecution(await auditExecutions({ root }));
  assert.equal(rows['tactical-code-p1'].plan_id, 'p1');
  assert.equal(rows['tactical-code-p2'].plan_id, 'p2');
  assert.equal(rows['tactical-code-p2'].retry, false, 'a different ticket is not a retry of the earlier one');
  assert.equal(rows[names.retry].retry, true);
});

test('the audit reports nothing it cannot observe as a pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'execution-audit-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await auditExecutions({ root: dir }), { status: 'unavailable', reason: 'orchestrator_state_missing', executions: [] });
  assert.deepEqual(await auditReadScope({ root: dir }), { status: 'unavailable', reason: 'orchestrator_state_missing', workers: [] });
  await write(join(dir, '.io/runtime/orchestrator/state.json'), JSON.stringify({ orchestrator_provider: 'claude-code', orchestrator_session_id: ORCHESTRATOR, stages: { 'to-ticket': stageEntry('to-ticket-1', { skill: 'to-ticket', native_agent_id: 'agent-x' }) } }));
  const audit = await auditExecutions({ root: dir });
  assert.equal(audit.status, 'partial');
  assert.equal(audit.executions[0].observation, 'unavailable');
  assert.match(audit.executions[0].observation_reason, /claude-code/, 'a Claude Code run has no Codex rollout to audit and says so');
});

test('read scope compares the files an implementation worker read with the modules its ticket declares and never blocks', async (t) => {
  const { root, threads } = await fixture(t);
  const home = process.env.CODEX_HOME;
  const plan = 'chat-send';
  const ticket = `docs/plans/${PLAN_SET}/${plan}.md`;
  await write(join(root, ticket), [
    '# 메시지 전송', '',
    '| 항목 | 값 |', '|---|---|', '| 컨텍스트 (BC) | chat |', '',
    '## 수정 대상', '- `src/chat/send-message.mjs`', '- `src/chat/`', '- `test/chat/send-message.test.mjs`', '- `migrations/*.sql`', '- `Conversation.create`', '',
  ].join('\n'));
  const workerThread = thread('7');
  const executionId = 'tactical-code-77777777-7777-4777-8777-777777777777';
  const orchestrator = (await readFile(join(home, 'sessions/2026/11/21', `rollout-2026-11-21T09-00-00-${ORCHESTRATOR}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  orchestrator.push(spawn('s7', { task_name: 'chat_send_worker', agent_type: 'tactical_implementation_agent', fork_turns: 'none', message: 'x' }, T(10)), started('s7', workerThread, '/root/chat_send_worker', T(10)));
  await rollout(home, ORCHESTRATOR, orchestrator);
  await rollout(home, workerThread, [
    { type: 'session_meta', payload: { id: workerThread, parent_thread_id: ORCHESTRATOR } }, ...turn('t1', 'gpt-6-luna', 'medium'),
    shell('cat AGENTS.md'),
    shell(`cat docs/specs/${PLAN_SET}/requirements.md`),
    shell('sed -n 1,80p src/chat/send-message.mjs'),
    shell('cat src/chat/unlisted-sibling.mjs'),
    shell('rg -n "send" src/'),
    shell('cat src/billing/invoice.mjs && nl -ba src/billing/tax.mjs | sed -n 1,5p'),
    jsCell('cat src/auth/session.mjs'),
    shell('cat > src/chat/new-file.mjs <<EOF\nexport const x = 1;\nEOF'),
    shell('node --test test/chat/send-message.test.mjs'),
    { timestamp: T(31), type: 'response_item', payload: { type: 'function_call', name: 'read_file', call_id: 'rf', arguments: JSON.stringify({ path: 'src/payments/ledger.mjs' }) } },
  ]);
  const statePath = join(root, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.stages['tactical-code'] = stageEntry(executionId, { skill: 'tactical-code', native_agent_id: '/root/chat_send_worker', started_at: T(10), finished_at: T(20) });
  await writeFile(statePath, JSON.stringify(state));
  await write(join(root, `.io/${PLAN_SET}/tactical-code/${executionId}/input.json`), JSON.stringify({ execution_id: executionId, skill: 'tactical-code', context: { plan_id: plan }, input_refs: [{ kind: 'ticket', base: 'workspace', path: ticket }] }));

  const report = await auditReadScope({ root });
  assert.equal(report.blocking, false, 'the report is observational');
  assert.equal(report.workers.length, 1);
  const [worker] = report.workers;
  assert.equal(worker.status, 'observed');
  assert.equal(worker.plan_id, plan);
  assert.equal(worker.thread_id, workerThread);
  assert.deepEqual(worker.declared.contexts, ['chat']);
  assert.ok(worker.declared.paths.includes('src/chat/send-message.mjs') && worker.declared.paths.includes('test/chat/send-message.test.mjs'));
  assert.ok(!worker.declared.paths.some((path) => path.includes('Conversation')), 'a code identifier is not a path');
  assert.deepEqual(worker.out_of_scope.map((item) => item.path), ['src/auth/session.mjs', 'src/billing/invoice.mjs', 'src/billing/tax.mjs', 'src/payments/ledger.mjs']);
  assert.equal(report.summary.out_of_scope_reads, 4);
  const scopes = Object.fromEntries(worker.reads.map((item) => [item.path, item.scope]));
  assert.equal(scopes['AGENTS.md'], 'harness_or_project_baseline');
  assert.equal(scopes[`docs/specs/${PLAN_SET}/requirements.md`], 'plan_set_document');
  assert.equal(scopes['src/chat/send-message.mjs'], 'declared');
  assert.equal(scopes['src/chat/unlisted-sibling.mjs'], 'declared', 'the directory of a declared module is in scope');
  assert.equal(scopes.src, 'declared_ancestor_search', 'searching above a declared module is broad, not out of scope');
  assert.equal(scopes['src/chat/new-file.mjs'], undefined, 'a redirection writes a file, it does not read one');
  assert.equal(scopes['test/chat/send-message.test.mjs'], undefined, 'running a test is not reading it');

  // Declaration and classification are plain functions of the ticket text and the paths.
  const declared = declaredScope('`src/a/b.mjs` `src/c/` `docs/*.md` `*.log` `Foo.bar` `/etc/passwd` `https://x.test/a.js`');
  assert.deepEqual(declared.paths, ['docs', 'src/a/b.mjs', 'src/c']);
  assert.equal(classifyRead('src/c/deep/file.mjs', { declared, kind: 'read' }), 'declared');
  assert.equal(classifyRead('src/other/file.mjs', { declared, kind: 'read' }), null);
  assert.equal(classifyRead('src', { declared, kind: 'search' }), 'declared_ancestor_search');
});

test('shell commands name the files they read, not the files they write or the patterns they search', () => {
  const paths = (command) => commandPaths(command).map(({ kind, path }) => `${kind}:${path}`);
  assert.deepEqual(paths("sed -n '1,40p' src/a.mjs"), ['read:src/a.mjs']);
  assert.deepEqual(paths('head -n 20 src/a.mjs src/b.mjs'), ['read:src/a.mjs', 'read:src/b.mjs']);
  assert.deepEqual(paths('rg -n "needle" src docs'), ['search:src', 'search:docs']);
  assert.deepEqual(paths('grep -rn foo --include "*.mjs" lib'), ['search:lib']);
  assert.deepEqual(paths('cat a.txt | wc -l'), ['read:a.txt']);
  assert.deepEqual(paths('cat src/in.mjs > out/copy.mjs'), [], 'a command that redirects its output is a write');
  assert.deepEqual(paths('CI=1 npm test'), []);
  assert.deepEqual(paths('node scripts/build.mjs --flag'), []);
  assert.deepEqual(paths('ls -la src/lib && cat lib/x.js'), ['search:src/lib', 'read:lib/x.js']);
});

test('the installed audit command is read-only, runs from the consumer, and update and Doctor keep it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'execution-audit-consumer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'consumer');
  await mkdir(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const home = process.env.CODEX_HOME;
  const clean = thread('a');
  const forked = thread('b');
  await rollout(home, ORCHESTRATOR, [
    { type: 'session_meta', payload: { id: ORCHESTRATOR } },
    spawn('s1', { task_name: 'clean_stage', agent_type: 'workflow_stage', fork_turns: 'none', model: 'gpt-6-luna', reasoning_effort: 'medium' }, T(2)), started('s1', clean, '/root/clean_stage', T(2)),
    spawn('s2', { task_name: 'forked_stage', agent_type: 'workflow_stage', fork_turns: 'all', model: 'gpt-6-luna', reasoning_effort: 'medium' }, T(3)), started('s2', forked, '/root/forked_stage', T(3)),
  ]);
  await rollout(home, clean, [{ type: 'session_meta', payload: { id: clean, parent_thread_id: ORCHESTRATOR } }, ...turn('t1', 'gpt-6-luna', 'medium')]);
  await rollout(home, forked, [{ type: 'session_meta', payload: { id: forked, parent_thread_id: ORCHESTRATOR, forked_from_id: ORCHESTRATOR } }, ...turn('t1', 'gpt-6-luna', 'medium')]);
  await write(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ orchestrator_session_id: ORCHESTRATOR, orchestrator_provider: 'codex', stages: {
    'stakeholder-analysis': stageEntry('stakeholder-analysis-clean', { skill: 'stakeholder-analysis', native_agent_id: clean }),
    'subdomain-candidates': stageEntry('subdomain-candidates-forked', { skill: 'subdomain-candidates', native_agent_id: forked }),
  } }));
  await attest(root, 'stakeholder-analysis-clean', 'captured', { thread_id: clean });
  const stateBefore = await readFile(join(root, '.io/runtime/orchestrator/state.json'), 'utf8');
  const run = (...args) => spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, encoding: 'utf8' });

  const all = run('executions');
  assert.equal(all.status, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.equal(report.executions.length, 2);
  assert.equal(report.summary.flagged, 1, 'flags are data: a flagged run still exits 0');
  assert.deepEqual(report.executions.map((row) => [row.stage_id, row.fork_turns, row.thread_id === clean || row.thread_id === forked]), [['stakeholder-analysis', 'none', true], ['subdomain-candidates', 'all', true]]);
  const flagged = JSON.parse(run('executions', '--flagged').stdout);
  assert.deepEqual(flagged.executions.map((row) => row.stage_id), ['subdomain-candidates']);
  assert.ok(flagged.executions[0].flags.includes('not_fresh') && flagged.executions[0].flags.includes('forked_transcript'));
  assert.equal(JSON.parse(run('read-scope').stdout).status, 'no_implementation_workers');
  assert.notEqual(run('bogus').status, 0);
  assert.equal(await readFile(join(root, '.io/runtime/orchestrator/state.json'), 'utf8'), stateBefore, 'the audit writes nothing');
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '');

  for (const path of [script, '.harness/src/workflow/execution-audit.mjs']) await unlink(join(root, path));
  const diagnostics = (await runDoctor({ root, sourceRoot })).diagnostics;
  for (const path of [script, '.harness/src/workflow/execution-audit.mjs']) assert.ok(diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith(path)), `${path} is part of the Doctor inventory`);
  await writeFile(join(root, 'app.txt'), 'project change\n');
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(run('executions').status, 0, 'update restores the command');
  git('check-ignore', '-v', script);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '?? app.txt');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'project change\n');
});
