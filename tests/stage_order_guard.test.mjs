import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PRE_SPEC_STAGES, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES, nextRequiredPreSpecStage, preSpecOrderViolation } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';

const read = (path) => readFile(join(sourceRoot, path), 'utf8');
const done = { status: 'completed', code: 'OK', result_ref: 'runtime/executions/x/result.json' };
const completed = (ids) => Object.fromEntries(ids.map((id) => [id, { ...done }]));
const script = (workspace, name, args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts', name), ...args], { cwd: workspace, encoding: 'utf8' });
const REQUEST = '게시글 삭제 기능을 추가해줘';

test('the order guard names the first earlier flow stage that is not completed and leaves workflows outside the flow alone', () => {
  // A workflow that never entered the flow, and the first stage of the flow, are not governed.
  assert.equal(nextRequiredPreSpecStage({ 'workflow-compose': done }, 'spec-me'), null, 'the helper only answers ordering; stage-input separately rejects retired spec-me');
  assert.equal(nextRequiredPreSpecStage({}, 'stakeholder-analysis'), null);
  assert.equal(nextRequiredPreSpecStage({}, 'implement-wrapper'), null);
  // Once it entered the flow, every earlier stage is required, in the order of the one list.
  assert.equal(nextRequiredPreSpecStage({}, 'subdomain-candidates'), 'stakeholder-analysis', 'a flow stage is governed even when the flow has not started');
  assert.equal(nextRequiredPreSpecStage(completed(REQUIREMENTS_STAGES), 'spec-me'), 'domain-model', 'the requirements flow alone does not complete tactical design');
  assert.equal(nextRequiredPreSpecStage(completed(REQUIREMENTS_STAGES), 'aggregate-design'), 'domain-model');
  assert.equal(nextRequiredPreSpecStage(completed(REQUIREMENTS_STAGES), 'domain-model'), null);
  assert.equal(nextRequiredPreSpecStage(completed(PRE_SPEC_STAGES), 'spec-me'), null);
  for (const [index, stage] of PRE_SPEC_STAGES.entries()) assert.equal(nextRequiredPreSpecStage(completed(PRE_SPEC_STAGES.slice(0, index)), stage), null, `${stage} follows its predecessor`);
  const gap = completed(PRE_SPEC_STAGES.slice(0, 9));
  delete gap['event-storming'];
  assert.equal(nextRequiredPreSpecStage(gap, 'spec-me'), 'event-storming', 'a stage missing from the middle is the next required one');
  // Only a completed stage with code OK counts.
  for (const entry of [{ status: 'waiting', code: 'USER_DECISION_REQUIRED', result_ref: 'r' }, { status: 'blocked', code: 'INPUT_MISSING', result_ref: 'r' }, { status: 'running' }, { status: 'failed', code: 'EXECUTION_ERROR' }]) {
    assert.equal(nextRequiredPreSpecStage({ ...completed(PRE_SPEC_STAGES), 'integration-design': entry }, 'spec-me'), 'integration-design', `${entry.status} is not completed`);
  }
  // A stage that already recorded a result is a resume, a user revision or a revision return of started work.
  assert.equal(nextRequiredPreSpecStage({ ...completed(REQUIREMENTS_STAGES), 'spec-me': { status: 'waiting', code: 'USER_DECISION_REQUIRED', result_ref: 'r' } }, 'spec-me'), null);
  assert.equal(nextRequiredPreSpecStage({ ...completed(REQUIREMENTS_STAGES), 'spec-me': { status: 'running', attempts: [{ status: 'waiting', result_ref: 'r' }] } }, 'spec-me'), null);
  // The message names the next stage; a stage recorded without a result also gets the way to discard it.
  const stages = { ...completed(REQUIREMENTS_STAGES), 'spec-me': { status: 'running' } };
  assert.match(preSpecOrderViolation(stages, 'spec-me'), /^spec-me cannot start before domain-model:.*domain-model is not started\. Complete domain-model next\..*--stage-id spec-me --discard-out-of-order true/);
  assert.doesNotMatch(preSpecOrderViolation(completed(REQUIREMENTS_STAGES), 'spec-me'), /discard-out-of-order/);
  assert.equal(preSpecOrderViolation(completed(PRE_SPEC_STAGES), 'spec-me'), null);
});

test('an installed consumer retires spec-me and requires tactical design before tactical-to-code', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, tree, treeGit, runStage, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const prepare = (...args) => script(workspace, 'harness-prepare-input.mjs', ['--verbose', ...args]);
  const refused = (stage, required) => {
    const result = prepare('--stage-id', stage);
    assert.notEqual(result.status, 0, `${stage} is refused`);
    assert.match(result.stderr, new RegExp(`${stage} cannot start before ${required}:`), result.stderr);
    return result;
  };
  const retired = () => { const result = prepare('--stage-id', 'spec-me'); assert.notEqual(result.status, 0); assert.match(result.stderr, /spec-me has been removed/); return result; };
  const stateFile = join(workspace, '.io/runtime/orchestrator/state.json');

  // No worktree may start spec-me, even before requirements-flow state exists.
  retired();
  refused('subdomain-candidates', 'stakeholder-analysis');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).stages['subdomain-candidates'], undefined, 'a refusal records nothing');

  // A skipped stakeholder-analysis completes the whole flow cheaply; stopping midway shows the next required stage.
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  refused('event-storming', 'subdomain-candidates');
  retired();
  const skipped = (stage) => runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
  for (const stage of REQUIREMENTS_STAGES.slice(1)) await skipped(stage);

  // The requirements flow alone cannot proceed to implementation.
  const head = treeGit('rev-parse', 'HEAD').trim();
  retired();
  refused('aggregate-design', 'domain-model');
  refused('integration-design', 'domain-model');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.stages['spec-me'], undefined);
  assert.equal(state.current_stage, 'bounded-context');
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);
  const next = JSON.parse(prepare('--stage-id', 'domain-model').stdout);
  assert.equal(next.input.context.transition.from_stage, 'bounded-context', 'the flow itself continues with domain-model');

  // The tactical stages complete, then tactical-to-code becomes eligible.
  for (const stage of TACTICAL_DESIGN_STAGES) await skipped(stage);
  retired();
  const ready = prepare('--stage-id', 'tactical-technology');
  assert.equal(ready.status, 0, ready.stderr);
  const prepared = JSON.parse(ready.stdout);
  assert.equal(prepared.input.context.stage_id, 'tactical-technology');

  // `start` cannot bypass the order with an input that was prepared earlier: it reads the state again.
  const after = JSON.parse(await readFile(stateFile, 'utf8'));
  const boundary = after.stages['context-boundary'];
  delete after.stages['context-boundary'];
  after.current_stage = 'application-service';
  await writeFile(stateFile, JSON.stringify(after, null, 2) + '\n');
  const start = script(workspace, 'harness-native-stage.mjs', ['start', '--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', prepared.input.execution_id]);
  assert.notEqual(start.status, 0);
  assert.match(start.stderr, /tactical-technology requires completed\/OK tactical design stage context-boundary/);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).stages['tactical-technology'], undefined, 'a refused start claims nothing');
  after.stages['context-boundary'] = boundary;
  after.current_stage = 'context-boundary';
  await writeFile(stateFile, JSON.stringify(after, null, 2) + '\n');
  const allowed = script(workspace, 'harness-native-stage.mjs', ['start', '--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', prepared.input.execution_id]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).stages['tactical-technology'].status, 'running', 'in order, start claims the stage');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the guard leaves the project tree clean');
});

test('an out-of-order stage whose native run ended is discarded through the supported command and the workflow returns to its previous stage', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, tree, treeGit, runStage, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const session = join(workspace, '.io');
  const stateFile = join(session, 'runtime/orchestrator/state.json');
  const recordFile = join(session, 'worktree.json');
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  const writeState = (state) => writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  const discard = (stage = 'spec-me') => script(workspace, 'harness-prepare-input.mjs', ['--stage-id', stage, '--discard-out-of-order', 'true']);
  const failure = (result, pattern) => { assert.notEqual(result.status, 0, 'the command refuses'); assert.match(JSON.parse(result.stderr).error, pattern); };

  // The requirements flow completed on an older Harness; the tactical design stages did not exist yet.
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  for (const stage of REQUIREMENTS_STAGES.slice(1)) await runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
  const settled = await readState();
  const parent = settled.orchestrator_session_id;
  assert.equal(settled.orchestrator_provider, 'codex');
  const head = treeGit('rev-parse', 'HEAD').trim();
  const workspaceReal = await realpath(workspace);

  // The state an older Harness left after a stale orchestrator started spec-me out of order and Codex was killed.
  const claim = async (extra = {}, stage = 'spec-me') => {
    const state = await readState();
    const now = new Date().toISOString();
    state.stages[stage] = { status: 'running', execution_id: `${stage}-${randomUUID()}`, model: 'codex-high', reasoning_effort: 'high', code: null, result_ref: null, result_session_directory: session, reason: null, updated_at: now, started_at: now, native_managed: true, skill: stage, ...extra };
    state.current_stage = stage;
    state.status = 'running';
    await writeState(state);
    return state.stages[stage];
  };
  const reset = async () => { await writeState(settled); };

  // Codex transcripts live in the isolated CODEX_HOME of the test run.
  const sessions = join(process.env.CODEX_HOME, 'sessions');
  await mkdir(sessions, { recursive: true });
  const transcript = join(sessions, `rollout-${parent}.jsonl`);
  t.after(async () => { for (const name of await readdir(sessions)) if (name.includes('rollout-')) await rm(join(sessions, name), { force: true }); });
  const writeParent = (...events) => writeFile(transcript, `${[{ type: 'session_meta', payload: { id: parent, cwd: workspaceReal } }, ...events].map((event) => JSON.stringify(event)).join('\n')}\n`);
  const started = (path, thread, at) => ({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: path, agent_thread_id: thread } } });
  const agentTranscript = (thread, path, ...events) => writeFile(join(sessions, `rollout-${thread}.jsonl`), `${[{ type: 'session_meta', payload: { id: thread, cwd: workspaceReal, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path } } } } }, ...events].map((event) => JSON.stringify(event)).join('\n')}\n`);

  // The stale orchestrator is refused with the next stage and the supported way out.
  let entry = await claim();
  const stale = script(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /spec-me has been removed/);
  assert.match(stale.stderr, /node \.codex\/scripts\/harness-prepare-input\.mjs --stage-id spec-me --discard-out-of-order true/);

  // Nothing proves the orchestrator stopped yet: the transcript is missing, then held open by a live process, then it shows a started subagent.
  failure(discard(), /orchestrator transcript was not found/);
  await writeParent();
  const holder = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("held\\n"); setInterval(() => {}, 1000);', transcript], { stdio: ['ignore', 'pipe', 'inherit'] });
  const holderExit = new Promise((resolve) => holder.once('exit', resolve));
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  failure(discard(), /still open/);
  holder.kill();
  await holderExit;
  await writeParent(started('/root/spec_me_restart', randomUUID(), Date.parse(entry.started_at) + 60_000));
  failure(discard(), /subagent started after the claim/);
  await writeParent(started('/root/earlier', randomUUID(), Date.parse(entry.started_at) - 60_000));

  // Project-owned changes are never touched: a dirty tree refuses, and the state stays as it was.
  await writeFile(join(workspace, 'app.txt'), 'application change in progress\n');
  failure(discard(), /clean project worktree/);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'application change in progress\n');
  assert.equal((await readState()).stages['spec-me'].execution_id, entry.execution_id);
  await writeFile(join(workspace, 'app.txt'), 'baseline\n');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');

  // A stage that follows the flow is not discarded; neither is one that recorded a result.
  await claim({}, 'domain-model');
  failure(discard('domain-model'), /not out of order/);
  await reset();
  await claim({ status: 'failed', code: 'EXECUTION_ERROR', native_finished: true, result_ref: 'runtime/executions/x/result.json' });
  failure(discard(), /not out of order/);
  await reset();
  await claim({ status: 'failed', code: 'EXECUTION_ERROR' });
  failure(discard(), /not confirmed/);
  await reset();
  failure(discard(), /not recorded/);

  // Nothing was discarded by the refusals above.
  entry = await claim();
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);

  // The recovery: transcript shows no subagent after the claim and no process holds the session.
  const result = JSON.parse(discard().stdout);
  assert.equal(result.status, 'ready');
  assert.equal(result.stage_id, 'spec-me');
  assert.equal(result.execution_id, entry.execution_id);
  assert.equal(result.previous_stage, 'bounded-context');
  const recovered = await readState();
  assert.equal(recovered.stages['spec-me'], undefined);
  assert.equal(recovered.current_stage, 'bounded-context');
  assert.equal(recovered.status, 'waiting');
  assert.equal(recovered.stages['bounded-context'].status, 'completed');
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).current_stage, 'bounded-context');
  const backup = JSON.parse(await readFile(join(result.backup, 'state.json'), 'utf8'));
  assert.equal(backup.stages['spec-me'].execution_id, entry.execution_id, 'the old state is archived');
  assert.equal(JSON.parse(await readFile(join(result.backup, 'worktree.json'), 'utf8')).current_stage, 'bounded-context');
  assert.equal(JSON.parse(await readFile(join(result.backup, 'discard.json'), 'utf8')).stage, 'spec-me');
  assert.equal(JSON.parse(await readFile(join(session, 'runtime/orchestrator/progress.json'), 'utf8')).current_stage, 'bounded-context', 'the progress view follows');
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head, 'no project commit was made');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the Harness-owned backup and state stay out of Git');
  treeGit('check-ignore', '-v', relative(workspace, join(result.backup, 'state.json')));
  treeGit('check-ignore', '-v', '.harness/src/workflow/requirements-restart.mjs');
  assert.equal(script(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']).status !== 0, true, 'spec-me is still refused after the recovery');
  const resumed = script(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-model']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).input.context.transition.from_stage, 'bounded-context', 'the workflow continues with the flow');
  assert.equal(JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')).stages['domain-model'], undefined, 'preparing records no stage until it starts');

  // A bound agent is verified through its own transcript, as for a restart: still running refuses, interrupted discards.
  const thread = randomUUID();
  entry = await claim({ native_agent_id: 'spec-me-agent' });
  const at = Date.parse(entry.started_at) + 1000;
  await writeParent(started('/root/spec-me-agent', thread, at));
  await agentTranscript(thread, '/root/spec-me-agent', { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } });
  failure(discard(), /cannot be verified stopped/);
  await agentTranscript(thread, '/root/spec-me-agent', { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }, { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1' } });
  const bound = JSON.parse(discard().stdout);
  assert.equal(bound.verified, 'native agent interrupted');
  assert.equal((await readState()).current_stage, 'bounded-context');

  // A stage that the native runner already recorded as failed is discarded without transcripts.
  await claim({ status: 'failed', code: 'EXECUTION_ERROR', reason: 'Native agent was interrupted by the host', native_finished: true, finished_at: new Date().toISOString() });
  const failed = JSON.parse(discard().stdout);
  assert.equal(failed.verified, 'native stage failed');
  assert.equal((await readState()).stages['spec-me'], undefined);
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);
  assert.equal((await readdir(join(session, 'runtime/restarts'))).filter((name) => name.startsWith('out-of-order-')).length, 3, 'each discard keeps its own archive');
});

test('the orchestrator links the input guide that owns the stage order guard and discard command', async () => {
  const input = await read('.codex/skills/orchestrator/references/input.md');
  assert.match(input, /--discard-out-of-order true/);
  assert.match(input, /cannot start before/);
  const orchestrator = await read('.codex/skills/orchestrator/SKILL.md');
  assert.match(orchestrator, /references\/input\.md/);
  const enforcement = await read('docs/architecture/enforcement.md');
  assert.match(enforcement, /preSpecOrderViolation[\s\S]*discardOutOfOrderStage/);
  const prepare = await read('.codex/scripts/harness-prepare-input.mjs');
  assert.match(prepare, /'discard-out-of-order'/);
  assert.match(await read('.codex/scripts/harness-native-stage.mjs'), /preSpecOrderViolation/);
  assert.ok(TACTICAL_DESIGN_STAGES.every((stage) => PRE_SPEC_STAGES.includes(stage)));
});
