import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { TAKEOVER_FEEDBACK, explainError, foreignRunningStage } from '../.harness/src/workflow/stage-cli.mjs';
import { PRE_SPEC_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow, sourceRoot, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const STAGE = 'stakeholder-analysis';
const NATIVE = 'harness-native-stage.mjs';
const PREPARE = 'harness-prepare-input.mjs';
const MODULE = '.harness/src/workflow/stage-takeover.mjs';
const question = { question_id: 'q-1', title: '삭제한 글을 복구할 수 있나요?', options: [{ id: 'no', label: '복구할 수 없다', consequence: '삭제는 되돌릴 수 없다', evidence: [] }, { id: 'yes', label: '복구할 수 있다', consequence: '삭제 상태를 보관한다', evidence: [] }], recommended_option_id: 'no', rationale: '요구사항이 그렇게 말한다', decision_kind: null };
const SKIPPED = (analysis) => ({ files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });

// A printed `node .codex/scripts/<script> ...` command, run the way the orchestrator runs it.
const printed = (workspace, command, sessionId) => {
  const parts = command.split(' ');
  assert.equal(parts[0], 'node', command);
  return spawnSync(process.execPath, parts.slice(1), { cwd: workspace, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: sessionId } });
};

// A consumer whose orchestrator Codex conversation (`old`) started a native stage and died, as a Codex process that was
// killed leaves it: the stage is `running`, its agent was bound, and the agent transcript ends without a terminal event.
async function interruptedWorkflow(t, { stage = STAGE, before = null, bind = true, asked = false } = {}) {
  const flow = await consumerWorkflow(t, REQUEST);
  if (before) await before(flow);
  const { workspace, treeGit } = flow;
  const session = join(workspace, '.io');
  const stateFile = join(session, 'runtime/orchestrator/state.json');
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  const old = (await readState()).orchestrator_session_id;
  const fresh = randomUUID();
  const workspaceReal = await realpath(workspace);
  const run = (script, args, sessionId = fresh) => spawnSync(process.execPath, [join(workspace, '.codex/scripts', script), ...args], { cwd: workspace, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: sessionId } });
  const ok = (result) => { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); };
  const refusal = (result, code = 'TAKEOVER_REFUSED') => {
    assert.notEqual(result.status, 0, 'the command refuses');
    const body = JSON.parse(result.stderr);
    assert.equal(body.code, code, result.stderr);
    assert.equal(typeof body.why, 'string');
    assert.ok((Array.isArray(body.next) && body.next.length) || body.user_decision, 'a next step or a user decision');
    return body;
  };
  const analysis = flow.specPath('stakeholder-analysis.md');

  let launched = ok(run(NATIVE, ['launch', '--stage-id', stage], old));
  let answers;
  if (asked) {
    ok(printed(workspace, launched.next.bind.replace('<agent_id>', 'analysis-agent-1'), old));
    await flow.submitStage({ stage, started: launched }, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', questions: [question], files: { [analysis]: stakeholderAnalysisDocument(REQUEST) } });
    assert.equal(ok(printed(workspace, launched.next.finish, old)).code, 'USER_DECISION_REQUIRED');
    // The runner checked the waiting document. This fixture is about the takeover of the resumed run, which requires a clean
    // project tree, so the uncommitted question-time document is removed here.
    await rm(join(workspace, analysis));
    launched = ok(run(NATIVE, ['launch', '--stage-id', stage, '--answer', 'no'], old));
    answers = await readFile(join(session, 'runtime/executions', launched.execution_id, 'answers.json'), 'utf8');
  }
  const agent = 'analysis-agent-2';
  if (bind) ok(printed(workspace, launched.next.bind.replace('<agent_id>', agent), old));
  const entry = (await readState()).stages[stage];
  assert.equal(entry.status, 'running');

  // The Codex transcripts: the old conversation spawned the agent, then both were killed with no terminal event.
  const sessions = join(process.env.CODEX_HOME, 'sessions');
  await mkdir(sessions, { recursive: true });
  const thread = randomUUID();
  const parentFile = join(sessions, `rollout-2026-11-17T00-00-00-${old}.jsonl`);
  const agentFile = join(sessions, `rollout-2026-11-17T00-00-01-${thread}.jsonl`);
  t.after(async () => { for (const file of [parentFile, agentFile]) await rm(file, { force: true }); });
  const line = (event) => JSON.stringify(event);
  // Real transcripts open with a session_meta line of tens of kilobytes and run to megabytes; the proofs must read both.
  const padding = 'x'.repeat(200_000);
  const filler = Array.from({ length: 3000 }, (_, index) => ({ type: 'response_item', payload: { type: 'message', text: `turn ${index}` } }));
  const parentEvents = (...extra) => [{ type: 'session_meta', payload: { id: old, cwd: workspaceReal, base_instructions: padding } }, ...filler, ...(bind ? [{ timestamp: new Date(Date.parse(entry.started_at) + 1000).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: `/root/${agent}`, agent_thread_id: thread } } }] : []), ...extra];
  const agentEvents = (...events) => [{ type: 'session_meta', payload: { id: thread, cwd: workspaceReal, base_instructions: padding, parent_thread_id: old, source: { subagent: { thread_spawn: { parent_thread_id: old, depth: 1, agent_path: `/root/${agent}` } } } } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }, ...events];
  const writeParent = (...extra) => writeFile(parentFile, `${parentEvents(...extra).map(line).join('\n')}\n`);
  const writeAgent = (...events) => writeFile(agentFile, `${agentEvents(...events).map(line).join('\n')}\n`);
  const hold = async (path) => {
    const holder = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("held\\n"); setInterval(() => {}, 1000);', path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    t.after(() => holder.kill());
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    return async () => { holder.kill(); await exited; };
  };
  // Nothing about the run may change when a takeover is refused.
  const untouched = async (before) => {
    const state = await readState();
    assert.equal(state.stages[stage].status, 'running');
    assert.equal(state.stages[stage].execution_id, before.execution_id);
    assert.equal(state.orchestrator_session_id, old);
    assert.equal(existsSync(join(session, 'runtime/restarts')) ? (await readdir(join(session, 'runtime/restarts'))).filter((name) => name.startsWith('takeover-')).length : 0, 0, 'a refusal archives nothing');
  };
  return { ...flow, session, stateFile, readState, old, fresh, run, ok, refusal, launched, entry, answers, analysis, writeParent, writeAgent, hold, untouched, agent, thread, parentFile, agentFile, workspaceReal, treeGit };
}

test('installed consumer: a new conversation takes over a stage its closed predecessor left running, only when that run provably ended', async (t) => {
  const f = await interruptedWorkflow(t, { asked: true });
  const { workspace, treeGit, session, readState, old, fresh, run, ok, refusal, launched, entry, answers, writeParent, writeAgent, hold, untouched, thread, parentFile, agentFile } = f;
  const takeover = ['launch', '--stage-id', STAGE, '--take-over', 'true'];
  const head = treeGit('rev-parse', 'HEAD').trim();
  const command = `node .codex/scripts/${NATIVE} launch --stage-id ${STAGE} --take-over true`;

  // The new conversation is told the exact command wherever it looks first: the context, inspect, and the refused launch.
  const context = ok(run('harness-context.mjs', []));
  assert.equal(context.current_stage, STAGE);
  assert.match(context.next, new RegExp(`${old}.*Do not send the user back.*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(ok(run('harness-context.mjs', [], old)).next, undefined, 'the conversation that started the stage waits for it instead');
  const stale = refusal(run(NATIVE, ['launch', '--stage-id', STAGE]), 'STAGE_RUNNING');
  assert.ok(stale.next[0].includes(command), 'launch names the takeover first');
  assert.ok(!stale.next.some((step) => /\bfail --execution-id/.test(step)), 'it is not told to record a failure it cannot observe');
  const inspectId = ['inspect', '--execution-id', launched.execution_id];
  await writeParent();
  await writeAgent();
  const inspected = ok(run(NATIVE, inspectId));
  assert.equal(inspected.session, 'other');
  assert.equal(inspected.thread_id, thread);
  assert.equal(inspected.native_outcome, 'running', 'a killed agent leaves no terminal event');
  assert.ok(inspected.next.includes(command));
  const own = ok(run(NATIVE, inspectId, old));
  assert.equal(own.session, 'this');
  assert.equal(own.next, undefined);

  // Refusals: each names its reason and leaves the run, the state and the project exactly as they were.
  await rm(parentFile);
  assert.match(refusal(run(NATIVE, takeover)).why, /orchestrator transcript was not found/);
  await untouched(entry);
  await writeParent();
  await writeAgent();
  const releaseParent = await hold(parentFile);
  const openParent = refusal(run(NATIVE, takeover));
  assert.match(openParent.why, /orchestrator Codex session is still open/);
  assert.ok(openParent.next[0].includes(command), 'close the old conversation, then repeat the same command');
  await untouched(entry);
  await releaseParent();
  const releaseAgent = await hold(agentFile);
  assert.match(refusal(run(NATIVE, takeover)).why, /native agent transcript is still open/);
  await untouched(entry);
  await releaseAgent();
  const own0 = refusal(run(NATIVE, takeover, old));
  assert.match(own0.why, /started stakeholder-analysis itself/, 'the conversation that started it waits instead');
  assert.deepEqual(own0.next, ['node .codex/scripts/harness-context.mjs']);
  await untouched(entry);
  const unset = spawnSync(process.execPath, [join(workspace, '.codex/scripts', NATIVE), ...takeover], { cwd: workspace, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '' } });
  assert.match(refusal(unset).why, /CODEX_THREAD_ID/);
  assert.match(refusal(run(NATIVE, [...takeover, '--answer', 'no'])).error, /must be requested alone/);
  assert.match(refusal(run(NATIVE, ['launch', '--stage-id', STAGE, '--take-over', 'yes'])).error, /must be requested alone/);
  await writeFile(join(workspace, 'app.txt'), 'application change in progress\n');
  const dirty = refusal(run(NATIVE, takeover));
  assert.match(dirty.why, /uncommitted changes/);
  assert.match(dirty.why, /app\.txt/);
  assert.match(dirty.user_decision, /commit or stash/);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'application change in progress\n', 'the project change is untouched');
  await untouched(entry);
  await writeFile(join(workspace, 'app.txt'), 'baseline\n');
  // An agent that finished and wrote its output is recorded with finish, not taken over.
  await writeAgent({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '{}' } });
  await writeFile(launched.output_path, '{}');
  const finished = refusal(run(NATIVE, takeover));
  assert.match(finished.why, /already completed and wrote its output/);
  assert.equal(finished.next[0], `node .codex/scripts/${NATIVE} finish --execution-id ${launched.execution_id}`);
  assert.equal(ok(run(NATIVE, inspectId)).next, `Its agent completed and wrote its output; record it: ${finished.next[0]}`);
  await untouched(entry);
  await rm(launched.output_path);
  await writeAgent();
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'refusals leave the tree clean');

  // The takeover: the run is recorded as interrupted, this conversation owns the workflow, and the stage runs again.
  const taken = ok(run(NATIVE, takeover));
  assert.equal(taken.status, 'launched');
  assert.equal(taken.stage_id, STAGE);
  assert.notEqual(taken.execution_id, launched.execution_id, 'a fresh execution');
  assert.equal(taken.taken_over.previous_execution_id, launched.execution_id);
  assert.equal(taken.taken_over.previous_session_id, old);
  assert.match(taken.taken_over.verified, /no process holds the orchestrator or agent transcript/);
  assert.equal(taken.taken_over.backup, undefined, 'the archive path is for --verbose');
  assert.match(taken.next.bind, new RegExp(`bind --execution-id ${taken.execution_id} --agent-id <agent_id>$`));
  const state = await readState();
  const running = state.stages[STAGE];
  assert.equal(state.orchestrator_session_id, fresh, 'the workflow follows this conversation');
  assert.equal(state.orchestrator_provider, 'codex');
  assert.equal(running.status, 'running');
  assert.equal(running.execution_id, taken.execution_id);
  assert.equal(running.taken_over, undefined, 'the marker belongs to the interrupted attempt');
  const interrupted = running.attempts.find((attempt) => attempt.execution_id === launched.execution_id);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.code, 'EXECUTION_ERROR');
  assert.equal(interrupted.native_finished, true);
  assert.equal(interrupted.result_ref, null);
  assert.match(interrupted.reason, /Interrupted: the Codex conversation that started this stage ended/);
  assert.equal(interrupted.taken_over.session_id, fresh);
  assert.equal(interrupted.taken_over.from_session_id, old);
  assert.equal(JSON.parse(await readFile(join(session, 'worktree.json'), 'utf8')).agent_sessions.orchestrator.session_id, fresh);
  // The earlier answers and the interrupted run's input travel with the new execution.
  const executions = join(session, 'runtime/executions', taken.execution_id);
  assert.equal(await readFile(join(executions, 'answers.json'), 'utf8'), answers, 'the answers already given are kept');
  assert.equal(JSON.parse(await readFile(join(executions, 'feedback.json'), 'utf8')).feedback, TAKEOVER_FEEDBACK);
  const input = JSON.parse(await readFile(taken.input_path, 'utf8'));
  assert.equal(input.context.orchestrator_session_id, fresh);
  assert.ok(input.input_refs.some((reference) => reference.kind === 'previous_execution_input'));
  // The archive keeps the state as the dead conversation left it.
  const [archive] = (await readdir(join(session, 'runtime/restarts'))).filter((name) => name.startsWith('takeover-'));
  const backup = join(session, 'runtime/restarts', archive);
  const before = JSON.parse(await readFile(join(backup, 'state.json'), 'utf8'));
  assert.equal(before.orchestrator_session_id, old);
  assert.equal(before.stages[STAGE].status, 'running');
  assert.equal(before.stages[STAGE].execution_id, launched.execution_id);
  const record = JSON.parse(await readFile(join(backup, 'takeover.json'), 'utf8'));
  assert.deepEqual([record.stage, record.execution_id, record.from_session_id, record.session_id, record.head], [STAGE, launched.execution_id, old, fresh, head]);
  assert.equal(JSON.parse(await readFile(join(session, 'runtime/orchestrator/progress.json'), 'utf8')).orchestrator_session_id, fresh, 'the progress view follows');
  // A second takeover while the new run is live is not a takeover: this conversation owns it.
  assert.match(refusal(run(NATIVE, takeover)).why, /itself/);

  // The new run completes as any other run.
  ok(printed(workspace, taken.next.bind.replace('<agent_id>', 'analysis-agent-3'), fresh));
  await f.submitStage({ stage: STAGE, started: taken }, SKIPPED(f.analysis));
  const done = ok(printed(workspace, taken.next.finish, fresh));
  assert.equal(done.status, 'completed');
  assert.equal(done.code, 'OK');
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [f.analysis], 'the runner commits the stage document only');
  assert.equal((await readState()).stages[STAGE].status, 'completed');

  // Git: Harness-owned files stay out, the project's own change stays visible and untouched.
  await writeFile(join(workspace, 'app.txt'), 'application change in progress\n');
  const status = treeGit('status', '--short', '--untracked-files=all');
  assert.match(status, /^ M app\.txt$/m);
  assert.doesNotMatch(status, /\.io\/|\.harness\/|\.codex\/|\.claude\/|\.agents\//);
  for (const path of [MODULE, relative(workspace, join(backup, 'state.json')), '.io/runtime/orchestrator/state.json']) assert.match(treeGit('check-ignore', '-v', path), /exclude/, path);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'application change in progress\n');
});

test('installed consumer: the two steps and a repeated command are safe, and a stage whose agent was never bound is taken over from the transcript alone', async (t) => {
  const f = await interruptedWorkflow(t, { bind: false });
  const { treeGit, readState, old, fresh, run, ok, refusal, launched, entry, writeParent, hold, untouched, parentFile } = f;
  const prepare = (args, sessionId = fresh) => run(PREPARE, args, sessionId);

  // Nothing proves the old conversation ended yet: its transcript is held open.
  await writeParent();
  const release = await hold(parentFile);
  assert.match(refusal(prepare(['--stage-id', STAGE, '--take-over-interrupted', 'true'])).why, /still open/);
  await untouched(entry);
  await release();
  // A subagent that was started but never bound died with its conversation: the conversation's end is the proof.
  await writeParent({ timestamp: new Date(Date.parse(entry.started_at) + 60_000).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: '/root/unbound', agent_thread_id: randomUUID() } } });

  // The mutation alone prints the exact next command; repeating it changes nothing and still names the same one.
  const first = ok(prepare(['--stage-id', STAGE, '--take-over-interrupted', 'true']));
  assert.equal(first.status, 'ready');
  assert.equal(first.already_taken_over, undefined);
  assert.equal(first.previous_session_id, old);
  assert.match(first.verified, /never bound an agent/);
  assert.equal(first.next, `The interrupted run is recorded and this conversation is the orchestrator now. Start the stage again with a fresh execution: node .codex/scripts/${NATIVE} launch --stage-id ${STAGE} --feedback '${TAKEOVER_FEEDBACK}'`);
  const failed = (await readState()).stages[STAGE];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.native_finished, true);
  assert.equal((await readState()).status, 'failed');
  assert.equal((await readdir(join(f.session, 'runtime/restarts'))).filter((name) => name.startsWith('takeover-')).length, 1);
  const again = ok(prepare(['--stage-id', STAGE, '--take-over-interrupted', 'true']));
  assert.equal(again.already_taken_over, true);
  assert.equal(again.execution_id, launched.execution_id);
  assert.equal((await readdir(join(f.session, 'runtime/restarts'))).filter((name) => name.startsWith('takeover-')).length, 1, 'repeating archives nothing');
  // Another conversation cannot reuse this conversation's takeover.
  assert.equal(refusal(prepare(['--stage-id', STAGE, '--take-over-interrupted', 'true'], randomUUID())).code, 'TAKEOVER_REFUSED');
  // The failed stage reads as an interrupted one everywhere else: context, and a launch with `--take-over true` that continues.
  assert.equal(ok(run('harness-context.mjs', [])).stages[STAGE].status, 'failed');
  const relaunched = ok(run(NATIVE, ['launch', '--stage-id', STAGE, '--take-over', 'true']));
  assert.equal(relaunched.status, 'launched');
  assert.equal(relaunched.taken_over.previous_execution_id, launched.execution_id);
  assert.equal((await readState()).stages[STAGE].execution_id, relaunched.execution_id);
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');
});

test('a takeover is offered only for a native stage that another Codex conversation left running, and every refusal explains itself', () => {
  const stage = { status: 'running', native_managed: true, execution_id: 'x-1' };
  const state = (overrides = {}) => ({ current_stage: STAGE, orchestrator_provider: 'codex', orchestrator_session_id: 'old-session', stages: { [STAGE]: { ...stage, ...overrides } } });
  assert.equal(foreignRunningStage(state(), 'new-session').stage, STAGE);
  assert.equal(foreignRunningStage(state(), 'old-session'), null, 'the conversation that started it');
  assert.equal(foreignRunningStage(state(), null), null, 'no conversation id');
  assert.equal(foreignRunningStage({ ...state(), orchestrator_provider: 'claude-code' }, 'new-session'), null);
  assert.equal(foreignRunningStage(state({ status: 'waiting' }), 'new-session'), null);
  assert.equal(foreignRunningStage(state({ native_managed: false }), 'new-session'), null);
  assert.equal(foreignRunningStage(state({ result_ref: 'r' }), 'new-session'), null);
  assert.equal(foreignRunningStage({ ...state(), current_stage: 'other' }, 'new-session'), null);
  const explain = (message, context = {}) => explainError(new Error(message), { root: join(sourceRoot, 'no-such-workspace'), stageId: STAGE, executionId: 'x-1', ...context });
  for (const message of [
    'Takeover refused: the project worktree has uncommitted changes that the interrupted stage may have left ( M app.txt)',
    'Takeover refused: its native agent already completed and wrote its output; record it with node .codex/scripts/harness-native-stage.mjs finish --execution-id x-1',
    'Takeover refused: this conversation started stakeholder-analysis itself, so its agent is waited for here, not taken over',
    'Takeover refused: stakeholder-analysis must be the current native stage and be running without a result (it is completed)',
    'Takeover refused: this command needs the id of the current Codex conversation (CODEX_THREAD_ID), which is not set',
    'Takeover refused: only a stage that a Codex conversation started can be taken over by another Codex conversation',
    'Takeover refused: another stage is running',
    'Taking over an interrupted stage must be requested alone',
  ]) {
    const body = explain(message);
    assert.equal(body.code, 'TAKEOVER_REFUSED', message);
    assert.ok(body.why.length > 10 && ((body.next || []).length || body.user_decision), message);
  }
  assert.equal(explain('Running stage cannot be verified stopped: the orchestrator Codex session is still open; close it first', { mode: 'takeover' }).code, 'TAKEOVER_REFUSED');
  assert.match(explain('Running stage cannot be verified stopped: x', { mode: 'takeover' }).next[0], /launch --stage-id stakeholder-analysis --take-over true$/);
  assert.equal(explain('Running stage cannot be verified stopped: x', { mode: 'discard' }).code, 'DISCARD_REFUSED');
  assert.equal(explain('Running stage cannot be verified stopped: x').code, 'RESTART_REFUSED');
});

test('update installs the takeover module in a consumer, Doctor requires it, Git ignores it, and the guides name the command', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { primary, workspace } = flow;
  const git = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;
  const lockPath = join(primary, '.codex/harness-lock.json');
  assert.ok(JSON.parse(await readFile(lockPath, 'utf8')).files[MODULE], 'fresh install records the module');
  assert.match(git('check-ignore', '-v', MODULE), /info\/exclude/);
  assert.equal(await readFile(join(workspace, MODULE), 'utf8'), await readFile(join(sourceRoot, MODULE), 'utf8'));
  await unlink(join(primary, MODULE));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  delete lock.files[MODULE];
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  assert.ok((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === join(primary, MODULE)), 'Doctor requires the module');
  await updateProject({ sourceRoot, targetRoot: primary });
  assert.equal(await readFile(join(primary, MODULE), 'utf8'), await readFile(join(sourceRoot, MODULE), 'utf8'), 'update installs the module');
  assert.ok(JSON.parse(await readFile(lockPath, 'utf8')).files[MODULE], 'update records it');
  assert.equal((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.match(git('check-ignore', '-v', MODULE), /info\/exclude/);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '');

  const read = (path) => readFile(join(sourceRoot, path), 'utf8');
  const skill = await read('.codex/skills/orchestrator/SKILL.md');
  assert.match(skill, /실행 배정·결과 확인·중단된 실행 복구.*references\/dispatch\.md/);
  const dispatch = await read('.codex/skills/orchestrator/references/dispatch.md');
  assert.match(dispatch, /launch --stage-id <stage> --take-over true/);
  assert.match(dispatch, /다른 Codex 대화[^\n]*그 대화로 돌아가지 않고 아래 인계를 쓴다/);
  assert.match(await read('.codex/skills/orchestrator/references/input.md'), /--take-over-interrupted true/);
  assert.match(await read('docs/architecture/enforcement.md'), /stage-takeover\.mjs[\s\S]*takeOverInterruptedStage/);
});

test('installed consumer: the last tactical design stage is taken over, and spec-me is retired', async (t) => {
  const STAGE_LAST = 'context-boundary';
  const f = await interruptedWorkflow(t, {
    stage: STAGE_LAST,
    before: async (flow) => {
      const analysis = flow.specPath('stakeholder-analysis.md');
      await flow.runStage('stakeholder-analysis', SKIPPED(analysis));
      for (const stage of PRE_SPEC_STAGES.slice(1, PRE_SPEC_STAGES.indexOf(STAGE_LAST))) await flow.runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
    },
  });
  const { workspace, treeGit, readState, old, fresh, run, ok, launched, writeParent, writeAgent } = f;
  const head = treeGit('rev-parse', 'HEAD').trim();
  await writeParent();
  await writeAgent();
  assert.equal((await readState()).current_stage, STAGE_LAST);

  // The new conversation runs the command it was handed, verbatim.
  const handed = /(node \.codex\/scripts\/harness-native-stage\.mjs launch --stage-id context-boundary --take-over true)/.exec(ok(run('harness-context.mjs', [])).next)?.[1];
  assert.ok(handed, 'the context hands over the command');
  const taken = JSON.parse((() => { const result = printed(workspace, handed, fresh); assert.equal(result.status, 0, result.stderr); return result.stdout; })());
  assert.equal(taken.status, 'launched');
  assert.equal(taken.stage_id, STAGE_LAST);
  assert.equal(taken.taken_over.previous_execution_id, launched.execution_id);
  assert.equal(taken.taken_over.previous_session_id, old);
  const state = await readState();
  assert.equal(state.orchestrator_session_id, fresh);
  assert.equal(state.current_stage, STAGE_LAST);
  assert.equal(state.stages[STAGE_LAST].attempts.at(-1).status, 'failed');
  assert.equal(ok(run('harness-context.mjs', [])).next, undefined, 'nothing is left to take over');

  // The resumed stage finishes like any other; new-feature work continues through tactical-to-code.
  ok(printed(workspace, taken.next.bind.replace('<agent_id>', 'context-boundary-resumed'), fresh));
  await f.submitStage({ stage: STAGE_LAST, started: taken }, { summary: `생략: stakeholder-analysis 판정 생략 (${f.analysis})` });
  const done = ok(printed(workspace, taken.next.finish, fresh));
  assert.equal(done.status, 'completed');
  assert.equal(done.code, 'OK');
  const ready = run(PREPARE, ['--verbose', '--stage-id', 'spec-me']);
  assert.equal(ready.status, 1);
  assert.match(ready.stderr, /spec-me has been removed/);
  const implementation = ok(run(PREPARE, ['--verbose', '--stage-id', 'tactical-technology']));
  assert.equal(implementation.input.context.stage_id, 'tactical-technology');
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head, 'the takeover committed nothing');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'Harness-owned state stays out of Git');
});
