import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { compactFinished, compactQuestions, explainError, extractVerbose, launchResult, spawnInstruction } from '../.harness/src/workflow/stage-cli.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';
import { childRollout, parentRollout, rolloutPath, writeRollout } from './support/codex-subagent-rollout.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const NATIVE = 'harness-native-stage.mjs';
const PREPARE = 'harness-prepare-input.mjs';
const bytes = (text) => Buffer.byteLength(text);
const exec = (workspace, script, args = [], input) => spawnSync(process.execPath, [join(workspace, '.harness/scripts', script), ...args], { cwd: workspace, encoding: 'utf8', input });
const ok = (result) => { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); };
// A refusal is one JSON object: what happened, why, and the exact next step or the decision the user makes.
function assertActionable(body) {
  assert.equal(typeof body.why, 'string', `says why: ${JSON.stringify(body)}`);
  assert.ok(body.why.length > 10);
  assert.ok((Array.isArray(body.next) && body.next.length && body.next.every((step) => typeof step === 'string' && step.trim())) || (typeof body.user_decision === 'string' && body.user_decision.trim()), `a next step or a user decision: ${JSON.stringify(body)}`);
}
const refusal = (result, code) => {
  assert.notEqual(result.status, 0, 'the command refuses');
  const body = JSON.parse(result.stderr || result.stdout);
  assert.equal(body.code, code, JSON.stringify(body));
  assertActionable(body);
  return body;
};
// Runs a printed `node .harness/scripts/<script> ...` command the way the orchestrator does, filling the agent placeholder.
const runPrinted = (workspace, command, agentId = 'agent-1') => {
  const parts = command.replace('<agent_id>', agentId).split(' ');
  assert.equal(parts[0], 'node', command);
  return spawnSync(process.execPath, parts.slice(1), { cwd: workspace, encoding: 'utf8' });
};
const SKIP = (analysis) => `생략: stakeholder-analysis 판정 생략 (${analysis})`;
const SKIPPED = (analysis) => ({ files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
const question = withDecisionContext({ question_id: 'q-1', title: '삭제한 글을 복구할 수 있나요?', options: [{ id: 'no', label: '복구할 수 없다', consequence: '삭제는 되돌릴 수 없다', evidence: [] }, { id: 'yes', label: '복구할 수 있다', consequence: '삭제 상태를 보관한다', evidence: [] }], recommended_option_id: 'no', rationale: '요구사항이 그렇게 말한다', decision_kind: null });

test('an installed stage honors an explicit model and effort and refuses a mismatched Codex worker', async (t) => {
  const { workspace, tree, treeGit, specPath, submitStage } = await consumerWorkflow(t, REQUEST);
  const record = JSON.parse(await readFile(tree.worktree_ref, 'utf8'));
  const priorBinding = { provider: 'codex', model: 'codex-workflow', reasoning_effort: 'low' };
  record.workflow_binding = priorBinding;
  await writeFile(tree.worktree_ref, JSON.stringify(record));
  const { session_id: parentId } = record.agent_sessions.orchestrator;
  const selected = { provider: 'codex', model: 'gpt-6-luna', reasoning_effort: 'medium' };
  const stage = 'stakeholder-analysis';
  const launched = ok(exec(workspace, NATIVE, ['launch', '--stage-id', stage, '--stage-binding', JSON.stringify(selected)]));
  const { model_tier, ...binding } = launched.binding;
  assert.deepEqual(binding, selected);
  assert.deepEqual(JSON.parse(await readFile(tree.worktree_ref, 'utf8')).workflow_binding, priorBinding);
  const agent = 'bound-worker';
  ok(runPrinted(workspace, launched.next.bind, agent));
  await submitStage({ stage, started: launched }, SKIPPED(specPath('stakeholder-analysis.md')));
  const head = treeGit('rev-parse', 'HEAD');
  const missing = refusal(runPrinted(workspace, launched.next.finish), 'MODEL_BINDING_UNVERIFIED');
  assert.ok(missing.next.some((step) => step.endsWith(launched.next.finish)));

  const sessions = join(process.env.CODEX_HOME, 'sessions');
  const thread = randomUUID();
  const rollout = (id, events) => writeFile(join(sessions, `rollout-fixture-${id}.jsonl`), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await mkdir(sessions, { recursive: true });
  await rollout(parentId, [
    { type: 'session_meta', payload: { id: parentId, cwd: workspace } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: `/root/${agent}`, agent_thread_id: thread } } },
  ]);
  const worker = (model, effort) => rollout(thread, [
    { type: 'session_meta', payload: { id: thread, cwd: workspace, parent_thread_id: parentId, source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: `/root/${agent}` } } } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'turn_context', payload: { turn_id: 'turn', model, effort } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'fixture complete' } },
  ]);
  const attest = async (model, effort) => {
    const directory = join(workspace, '.io/runtime/executions', launched.execution_id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'native-attestation.jsonl'), `${JSON.stringify({
      schema_version: 1, execution_id: launched.execution_id, stage_id: stage,
      parent_session_id: parentId, native_agent_id: agent, thread_id: thread,
      status: 'captured', turns: [{ turn_id: 'turn', status: 'completed', model, reasoning_effort: effort }],
    })}\n`);
  };
  for (const [model, effort] of [['gpt-6.2-astra', 'medium'], ['gpt-6-luna', 'low']]) {
    await worker(selected.model, selected.reasoning_effort);
    await attest(selected.model, selected.reasoning_effort);
    await appendFile(join(sessions, `rollout-fixture-${thread}.jsonl`), [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'repair' } },
      { type: 'turn_context', payload: { turn_id: 'repair', model, effort } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'repair', last_agent_message: 'mismatching repair' } },
    ].map((event) => `${JSON.stringify(event)}\n`).join(''));
    const mismatch = refusal(runPrinted(workspace, launched.next.finish), 'MODEL_BINDING_MISMATCH');
    assert.ok(mismatch.why.includes(`${model}/${effort} (completed)`));
    assert.ok(mismatch.next.every((step) => !step.includes('finish')));
    assert.equal(treeGit('rev-parse', 'HEAD'), head);
  }
  await worker(selected.model, selected.reasoning_effort);
  await attest(selected.model, selected.reasoning_effort);
  const inspected = ok(exec(workspace, NATIVE, ['inspect', '--execution-id', launched.execution_id]));
  assert.deepEqual(inspected.requested_binding, selected);
  assert.deepEqual(inspected.observed_bindings, [{ model: selected.model, reasoning_effort: selected.reasoning_effort, turn_id: 'turn' }]);
  assert.equal(ok(runPrinted(workspace, launched.next.finish)).code, 'OK');
  assert.equal(treeGit('status', '--short', '-uall'), '');
  const asset = '.harness/scripts/harness-native-stage.mjs';
  await unlink(join(workspace, asset));
  assert.ok((await runDoctor({ root: workspace })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path === join(workspace, asset)));
  await writeFile(join(workspace, 'app.txt'), 'application edit\n');
  await updateProject({ sourceRoot, targetRoot: workspace });
  assert.equal(await readFile(join(workspace, asset), 'utf8'), await readFile(join(sourceRoot, asset), 'utf8'));
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'application edit\n');
  assert.equal(treeGit('status', '--short', '-uall'), ' M app.txt\n');
  for (const path of [asset, '.harness/schemas/input.schema.json']) assert.match(treeGit('check-ignore', '-v', path), /info\/exclude/);
});

test('the stage commands print only what the next step needs, and --verbose prints the full detail', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, tree, specPath, runStage, beginStage, submitStage } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  await runStage('stakeholder-analysis', SKIPPED(analysis));

  // prepare: the execution to start, not the stored input.
  const stage = 'subdomain-candidates';
  const full = exec(workspace, PREPARE, ['--verbose', '--stage-id', stage]);
  const compact = exec(workspace, PREPARE, ['--stage-id', stage]);
  const verbosePrepared = ok(full), prepared = ok(compact);
  assert.ok(verbosePrepared.input.context.transition.summary && verbosePrepared.input.input_refs.length, 'verbose keeps the whole input');
  assert.deepEqual(Object.keys(prepared), ['status', 'execution_id', 'stage_id', 'from_stage', 'from_code', 'next']);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.from_stage, 'stakeholder-analysis');
  assert.equal(prepared.next, `node .harness/scripts/${NATIVE} start --execution-id ${prepared.execution_id}`);
  assert.ok(bytes(compact.stdout) <= 500, `prepare is ${bytes(compact.stdout)} bytes`);
  assert.ok(bytes(compact.stdout) * 3 < bytes(full.stdout), 'prepare is a third of its verbose size or less');

  // start: what spawn_agent needs and the bind command, without the workspace, the sandbox or the binding's skill.
  const startOutput = exec(workspace, NATIVE, ['start', '--execution-id', prepared.execution_id]);
  const started = ok(startOutput);
  assert.deepEqual(Object.keys(started).sort(), ['agent_profile', 'assignment_path', 'binding', 'document_draft_root', 'guide', 'input_path', 'next', 'output_path', 'schema_path']);
  assert.equal(started.agent_profile, 'workflow_stage');
  assert.deepEqual(Object.keys(started.binding).sort(), ['model', 'model_tier', 'provider', 'reasoning_effort']);
  assert.equal(started.document_draft_root, join(workspace, '.io/runtime/executions', prepared.execution_id, 'document-drafts/workspace'));
  for (const path of [started.guide, started.input_path, started.schema_path, started.document_draft_root]) assert.ok(existsSync(path), path);
  assert.match(started.next, new RegExp(`bind --execution-id ${prepared.execution_id} --agent-id <agent_id>$`));
  // Absolute dispatch paths repeat the fixture checkout prefix, which depends on the session's TMPDIR.
  const startContractBytes = bytes(startOutput.stdout.replaceAll(workspace, '<workspace>'));
  assert.ok(startContractBytes <= 1500, `start is ${startContractBytes} bytes with the workspace prefix normalized`);

  // bind and finish.
  const bound = ok(exec(workspace, NATIVE, ['bind', '--execution-id', prepared.execution_id, '--agent-id', 'agent-1']));
  assert.deepEqual(bound, { status: 'running', execution_id: prepared.execution_id, agent_id: 'agent-1', receive_command: `node .harness/scripts/${NATIVE} receive --execution-id ${prepared.execution_id} --agent-id 'agent-1'` });
  await submitStage({ stage, started }, { summary: SKIP(analysis) });
  const finishOutput = exec(workspace, NATIVE, ['finish', '--execution-id', prepared.execution_id]);
  const finished = ok(finishOutput);
  assert.deepEqual(Object.keys(finished), ['status', 'code', 'execution_id', 'stage_id', 'result_ref', 'result', 'next']);
  assert.deepEqual(Object.keys(finished.result), ['summary', 'artifacts']);
  assert.equal(finished.result.summary, SKIP(analysis));
  assert.ok(bytes(finishOutput.stdout) <= 700, `finish is ${bytes(finishOutput.stdout)} bytes`);
  assert.match(finished.next, /^Next stage: .*launch --stage-id ubiquitous-language$/, 'the next stage is named, so the orchestrator reads no workflow map');

  // The legacy start output stays available: the workspace, the sandbox and the whole binding.
  const second = await beginStage('ubiquitous-language');
  await submitStage(second, { summary: SKIP(analysis), artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }] });
  const verbose = ok(exec(workspace, NATIVE, ['finish', '--execution-id', second.prepared.input.execution_id, '--verbose']));
  assert.equal(verbose.result.schema_version, 1);
  assert.equal(verbose.result.execution_id, second.prepared.input.execution_id);
  assert.match(verbose.result.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(verbose.result.questions, []);
  assert.equal(verbose.result.review_request, null);
  assert.deepEqual(Object.keys(verbose), ['status', 'code', 'result_ref', 'result']);
  const third = ok(exec(workspace, PREPARE, ['--stage-id', 'event-storming']));
  const legacyStart = ok(exec(workspace, NATIVE, ['start', '--execution-id', third.execution_id, '--verbose']));
  assert.equal(legacyStart.workspace, workspace);
  assert.equal(legacyStart.sandbox, 'workspace-write');
  assert.equal(legacyStart.binding.skill, 'event-storming');
  assert.equal(legacyStart.next, undefined);

  // harness-context: a finished stage is one short entry; --verbose is the whole record.
  const context = exec(workspace, 'harness-context.mjs');
  const wide = exec(workspace, 'harness-context.mjs', ['--verbose']);
  assert.deepEqual(JSON.parse(context.stdout).stages['stakeholder-analysis'], { status: 'completed', code: 'OK' });
  assert.ok(JSON.parse(wide.stdout).stages['stakeholder-analysis'].summary);
  assert.ok(bytes(context.stdout) < bytes(wide.stdout) * 0.7, `context is ${bytes(context.stdout)} of ${bytes(wide.stdout)} bytes`);
  assert.equal(JSON.parse(context.stdout).worktree_ref, tree.worktree_ref);
  t.diagnostic(`bytes: prepare ${bytes(compact.stdout)} (verbose ${bytes(full.stdout)}), start ${bytes(startOutput.stdout)} (verbose ${bytes(JSON.stringify(legacyStart))}), finish ${bytes(finishOutput.stdout)}, context ${bytes(context.stdout)} (verbose ${bytes(wide.stdout)})`);
});

test('installed consumer: launch prepares and starts a stage in one call, the printed bind and finish commands work, and Git keeps Harness files out and project files visible', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { primary, workspace, treeGit, specPath, submitStage } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const primaryGit = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;

  // The managed module ships: it is in the installed lock, Git ignores it and Doctor requires it.
  const lock = JSON.parse(await readFile(join(primary, '.harness/harness-lock.json'), 'utf8'));
  assert.ok(lock.files['.harness/src/workflow/stage-cli.mjs'], 'fresh install records the module');
  assert.match(primaryGit('check-ignore', '-v', '.harness/src/workflow/stage-cli.mjs'), /info\/exclude/);
  assert.equal(await readFile(join(workspace, '.harness/src/workflow/stage-cli.mjs'), 'utf8'), await readFile(join(sourceRoot, '.harness/src/workflow/stage-cli.mjs'), 'utf8'));

  const output = exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']);
  const launched = ok(output);
  assert.equal(launched.status, 'launched');
  assert.equal(launched.stage_id, 'stakeholder-analysis');
  assert.equal(launched.agent_profile, 'workflow_stage');
  assert.equal(launched.binding.model, 'codex-implementation');
  assert.equal(launched.binding.reasoning_effort, 'medium');
  for (const path of [launched.guide, launched.input_path, launched.schema_path]) assert.ok(existsSync(path), path);
  assert.equal(launched.next.bind, `node .harness/scripts/${NATIVE} bind --execution-id ${launched.execution_id} --agent-id <agent_id>`);
  assert.equal(launched.next.finish, `node .harness/scripts/${NATIVE} finish --execution-id ${launched.execution_id}`);
  // The spawn instruction names fork_turns "none": a Codex start without it is denied by the fresh-agent hook.
  assert.match(launched.next.spawn, /spawn_agent \{agent_type: "workflow_stage", fork_turns: "none"\}/);
  assert.ok(bytes(output.stdout) <= 2200, `launch is ${bytes(output.stdout)} bytes`);
  assert.deepEqual(await readdir(join(workspace, '.io/runtime/launch-attempts')), [], 'successful launch removes its temporary receipt');
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  assert.equal(state.stages['stakeholder-analysis'].status, 'running');
  assert.equal(state.stages['stakeholder-analysis'].execution_id, launched.execution_id);
  assert.equal(state.stages['stakeholder-analysis'].native_managed, true);

  // A second launch of the running stage is refused with the commands that resolve it.
  const again = refusal(exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']), 'STAGE_RUNNING');
  assert.ok(again.next.some((step) => step.endsWith(`finish --execution-id ${launched.execution_id}`)));

  // The printed commands are the orchestrator's whole protocol: bind with the real agent id, then finish.
  assert.equal(ok(runPrinted(workspace, launched.next.bind, 'analysis-agent')).agent_id, 'analysis-agent');
  await submitStage({ stage: 'stakeholder-analysis', started: launched }, SKIPPED(analysis));
  const finished = ok(runPrinted(workspace, launched.next.finish));
  assert.equal(finished.status, 'completed');
  assert.equal(finished.code, 'OK');
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [analysis], 'the runner commits the stage document only');

  // Application-owned changes stay visible and untouched; Harness-owned files stay out of Git in both checkouts.
  await writeFile(join(workspace, 'app.txt'), 'application change in progress\n');
  const status = treeGit('status', '--short', '--untracked-files=all');
  assert.match(status, /^ M app\.txt$/m);
  assert.doesNotMatch(status, /\.io\/|\.harness\/|\.codex\/|\.claude\/|\.agents\//);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'application change in progress\n');
  for (const path of ['.harness/src/workflow/stage-cli.mjs', '.harness/scripts/harness-native-stage.mjs', '.io/runtime/orchestrator/state.json']) assert.match(treeGit('check-ignore', '-v', path), /exclude/, path);
  assert.equal(primaryGit('status', '--short', '--untracked-files=all').trim(), '');

  // The next stage launches from the compact transition, again in one call.
  const next = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'subdomain-candidates']));
  assert.equal(next.from_stage, 'stakeholder-analysis');
  assert.equal(next.from_code, 'OK');
  refusal(runPrinted(workspace, next.next.bind, '/root/analysis-agent'), 'FRESH_AGENT_REQUIRED');
  await submitStage({ stage: 'subdomain-candidates', started: next }, { summary: SKIP(analysis) });
  const bound = runPrinted(workspace, next.next.bind);
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(ok(runPrinted(workspace, next.next.finish)).status, 'completed');

  // A launch that needs the user instead of a new run (a partial answer batch) reports it and starts nothing.
  const asked = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'ubiquitous-language']));
  ok(runPrinted(workspace, asked.next.bind, 'language-agent'));
  await submitStage({ stage: 'ubiquitous-language', started: asked }, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', questions: [question] });
  const waiting = ok(runPrinted(workspace, asked.next.finish));
  assert.equal(waiting.code, 'USER_DECISION_REQUIRED');
  assert.equal(waiting.result.questions[0].title, question.title, 'the question is relayed whole');
  assert.match(waiting.next, /answer --text '<the user's reply verbatim>'/);
  assert.match(waiting.next, /without opening any file/);
  const resumed = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'ubiquitous-language', '--answer', 'no']));
  assert.equal(resumed.status, 'launched');
  assert.equal(resumed.answered, true);
  assert.equal(JSON.parse(await readFile(resumed.answers_path, 'utf8'))[0].answer, 'no');
  assert.equal(resumed.feedback_path, undefined);
  refusal(runPrinted(workspace, resumed.next.bind, 'language-agent'), 'FRESH_AGENT_REQUIRED');
  ok(runPrinted(workspace, resumed.next.bind, 'language-answer-agent'));
  assert.equal(treeGit('status', '--short', '--untracked-files=all').replace(/^ M app\.txt\n?/m, '').trim(), '');
});

test('update restores the output module of an installed consumer and Doctor requires it', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { primary } = flow;
  const module = '.harness/src/workflow/stage-cli.mjs';
  const git = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;
  await unlink(join(primary, module));
  const lockPath = join(primary, '.harness/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  delete lock.files[module];
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  assert.ok((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === join(primary, module)), 'Doctor requires the module');
  assert.ok(!existsSync(join(primary, module)));
  await updateProject({ sourceRoot, targetRoot: primary });
  assert.equal(await readFile(join(primary, module), 'utf8'), await readFile(join(sourceRoot, module), 'utf8'), 'update installs the module');
  assert.ok(JSON.parse(await readFile(lockPath, 'utf8')).files[module], 'update records it');
  assert.equal((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.match(git('check-ignore', '-v', module), /info\/exclude/);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '');
});

test('every error the orchestrator can hit in the stage flow says what happened, why and the next step', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { primary, workspace, tree, specPath, submitStage, finishStage } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const ids = (body) => body.next.join('\n');

  // Order guard: the stale instruction is named, with the stage the flow needs and its own next step.
  const order = refusal(exec(workspace, PREPARE, ['--stage-id', 'event-storming']), 'STAGE_ORDER');
  assert.match(order.error, /event-storming cannot start before stakeholder-analysis/);
  assert.equal(order.next[0], `node .harness/scripts/${NATIVE} launch --stage-id stakeholder-analysis`);
  assert.equal(refusal(exec(workspace, NATIVE, ['launch', '--stage-id', 'event-storming']), 'STAGE_ORDER').next[0], order.next[0], 'launch passes the explained refusal on unchanged');

  // Arguments and workspace.
  refusal(exec(workspace, PREPARE, ['--stage-id']), 'INVALID_ARGUMENT');
  refusal(exec(workspace, NATIVE, ['finish']), 'INVALID_ARGUMENT');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'tracker-publish']), 'STAGE_ORDER');
  const wrong = refusal(exec(primary, NATIVE, ['finish', '--execution-id', 'x-1']), 'WRONG_WORKSPACE');
  assert.ok(wrong.user_decision);
  assert.match(ids(refusal(exec(primary, NATIVE, ['finish', '--root', workspace, '--execution-id', 'x-1']), 'WRONG_WORKSPACE')), new RegExp(`cd ${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  refusal(exec(workspace, NATIVE, ['finish', '--execution-id', 'never-prepared']), 'INPUT_NOT_FOUND');

  // A prepared execution that was never started is not running; a started one is not bound until the agent ID is recorded.
  const prepared = ok(exec(workspace, PREPARE, ['--stage-id', 'stakeholder-analysis']));
  const launched = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']));
  const id = launched.execution_id;
  const begun = { stage: 'stakeholder-analysis', started: launched, base: ['--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', id] };
  const notStarted = refusal(exec(workspace, NATIVE, ['finish', '--execution-id', prepared.execution_id]), 'NOT_RUNNING');
  assert.match(ids(notStarted), /harness-context\.mjs/);
  const unbound = refusal(exec(workspace, NATIVE, ['finish', '--execution-id', id]), 'NOT_BOUND');
  // finish before any worker exists tells the orchestrator to start the fresh worker (fork_turns "none"), then bind it.
  assert.match(unbound.next[0], /Spawn the fresh worker .*fork_turns: "none"/);
  assert.equal(unbound.next[1], `node .harness/scripts/${NATIVE} bind --execution-id ${id} --agent-id <agent_id>`);
  // The stage is running now: it is not prepared or started twice.
  const pending = refusal(exec(workspace, PREPARE, ['--stage-id', 'stakeholder-analysis']), 'STAGE_RUNNING');
  assert.ok(pending.next.some((step) => step.includes(`inspect --execution-id ${id}`)));
  refusal(exec(workspace, NATIVE, ['start', '--execution-id', prepared.execution_id]), 'STAGE_RUNNING');
  ok(runPrinted(workspace, launched.next.bind));

  // finish rejects a format error with the repair route, and a result the runner will not record with its own route.
  await writeFile(begun.started.output_path, JSON.stringify({ schema_version: 1, skill: 'stakeholder-analysis', status: 'completed' }));
  const format = JSON.parse(finishStage(begun).stdout);
  assert.equal(format.status, 'format_error');
  assert.equal(format.code, 'FORMAT_ERROR');
  assertActionable(format);
  assert.ok(format.errors.length && format.next.some((step) => step.endsWith(`finish --execution-id ${id}`)));
  await submitStage(begun, { ...SKIPPED(analysis), questions: [question] });
  const rejected = finishStage(begun);
  assert.notEqual(rejected.status, 0);
  const rejection = JSON.parse(rejected.stderr);
  assert.equal(rejection.code, 'RESULT_REJECTED', rejected.stderr);
  assertActionable(rejection);
  await submitStage(begun, SKIPPED(analysis));
  assert.equal(ok(finishStage(begun)).status, 'completed');

  // Finishing the same execution again is not a failure to retry: the refusal says the result is recorded.
  const repeated = refusal(finishStage(begun), 'NOT_RUNNING');
  assert.match(repeated.why, /already completed\/OK/);
  assert.match(ids(repeated), /Do not run it again/);

  // Answers, feedback and revisions that no stage state allows.
  refusal(exec(workspace, PREPARE, ['--stage-id', 'subdomain-candidates', '--answer', 'yes']), 'ANSWER_REFUSED');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'subdomain-candidates', '--feedback', '다시 해 줘']), 'FEEDBACK_REFUSED');
  const revision = refusal(exec(workspace, PREPARE, ['--stage-id', 'requirements-fix', '--user-revision', 'true']), 'USER_REVISION_REFUSED');
  assert.match(ids(revision), /--user-revision true --feedback /);
  refusal(exec(workspace, PREPARE, ['--stage-id', 'subdomain-candidates', '--feedback', '다시', '--user-revision', 'true']), 'USER_REVISION_REFUSED');

  // Restart and discard refusals name the reason and what to do.
  refusal(exec(workspace, PREPARE, ['--stage-id', 'subdomain-candidates', '--restart-requirements', 'true']), 'RESTART_REFUSED');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'stakeholder-analysis', '--restart-requirements', 'true', '--feedback', 'x']), 'RESTART_REFUSED');
  const dirty = join(workspace, 'app.txt');
  await writeFile(dirty, 'application change in progress\n');
  const restartDirty = refusal(exec(workspace, PREPARE, ['--stage-id', 'stakeholder-analysis', '--restart-requirements', 'true']), 'RESTART_REFUSED');
  assert.ok(restartDirty.user_decision && /commit or stash/.test(restartDirty.user_decision));
  assert.equal(await readFile(dirty, 'utf8'), 'application change in progress\n', 'a refused restart leaves project files alone');
  await writeFile(dirty, 'baseline\n');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'subdomain-candidates', '--discard-out-of-order', 'true']), 'DISCARD_REFUSED');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'stakeholder-analysis', '--discard-out-of-order', 'true']), 'DISCARD_REFUSED');

  // A previous stage that is still running, or that asked the user something, blocks the stage chosen after it.
  const flowRun = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'subdomain-candidates']));
  const guarded = refusal(exec(workspace, PREPARE, ['--stage-id', 'ubiquitous-language']), 'STAGE_ORDER');
  assert.match(ids(guarded), new RegExp(`finish --execution-id ${flowRun.execution_id}`), 'the order guard names the running stage to finish');
  const unusable = refusal(exec(workspace, PREPARE, ['--stage-id', 'implement-wrapper', '--plan', 'any-plan']), 'PREVIOUS_RESULT_MISSING');
  assert.match(unusable.error, /subdomain-candidates is running/);
  assert.match(ids(unusable), new RegExp(`finish --execution-id ${flowRun.execution_id}`));
  ok(runPrinted(workspace, flowRun.next.bind, 'candidate-agent'));
  await submitStage({ stage: 'subdomain-candidates', started: flowRun }, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', questions: [question] });
  ok(runPrinted(workspace, flowRun.next.finish));
  const unresolved = refusal(exec(workspace, PREPARE, ['--stage-id', 'implement-wrapper', '--plan', 'any-plan']), 'PREVIOUS_UNRESOLVED');
  assert.ok(unresolved.user_decision, 'the question is the user\'s');
  assert.match(ids(unresolved), /launch --stage-id subdomain-candidates --answer/);
  const waitingOrder = refusal(exec(workspace, PREPARE, ['--stage-id', 'ubiquitous-language']), 'STAGE_ORDER');
  assert.ok(waitingOrder.user_decision, 'a waiting stage in the way is answered, not skipped');
});

test('the explanation catalogue covers the errors the stage commands throw and each explanation leaves a next step', async () => {
  const files = ['.harness/src/workflow/stage-input.mjs', '.harness/src/workflow/requirements-restart.mjs', '.harness/src/workflow/stage-takeover.mjs', '.harness/src/workflow/execution-state.mjs', '.harness/src/workflow/worktree-stages.mjs', '.harness/scripts/harness-prepare-input.mjs', '.harness/scripts/harness-native-stage.mjs', '.harness/src/workflow/cli-context.mjs', '.harness/src/workflow/execution-input.mjs', '.harness/src/workflow/tactical-tickets.mjs'];
  // Internal integrity failures name no recovery the orchestrator can run; they fall back to a report-to-user decision.
  const INTEGRITY = /^(Invalid process identity|Invalid workflow state schema|Workflow reference mismatch|Workflow already active|Current stage is not|Current workflow stage is not completed|Recovery target|Stage execution changed|Invalid terminal transition|Invalid orchestrator session|Unsafe|Invalid, duplicate|Invalid canonical|Invalid restart|Invalid interrupted|Cannot (archive|recover|establish)|Unknown interrupted|Stage workspace must|Planning workspace|Producer|Execution session|Restart input session|Invalid active worktree|Invalid execution input identity|Canonical worktree|Invalid E2E|Invalid test defect|Invalid deferred|Invalid ID|Cannot verify|Blocked implementation result|Legacy SUBTASK_REQUIRED|Multiple restart|Spec approval|Pending answers|Recorded decision|Dependency incomplete|Native output|Native agent|Native subagent (output|binding is)|Reconciliation|Input|Restart archive|Archived restart|Worktree reference does not match workflow|harness-.*printed no result)/;
  const messages = new Set();
  for (const file of files) {
    const text = await readFile(join(sourceRoot, file), 'utf8');
    for (const [, quote, body] of text.matchAll(/new Error\((['`])((?:\\.|(?!\1)[^\\])*)\1/g)) messages.add(body.replace(/\$\{[^}]*\}/g, 'X').replace(/\\(.)/g, '$1'));
  }
  assert.ok(messages.size > 100, `scanned ${messages.size} messages`);
  const generic = [];
  for (const message of messages) {
    const body = explainError(new Error(message), { root: join(sourceRoot, 'no-such-workspace'), stageId: 'requirements-fix', executionId: 'x-1' });
    assertActionable(body);
    if (body.code === 'HARNESS_ERROR' && !INTEGRITY.test(message)) generic.push(message);
  }
  assert.deepEqual(generic, [], 'every error the orchestrator can act on has an explanation; add a rule (or list an integrity failure)');

  // The refusals that cannot be provoked on a clean consumer, each with its own explanation.
  const explain = (message, context = {}) => explainError(new Error(message), { root: join(sourceRoot, 'no-such-workspace'), stageId: 'requirements-fix', executionId: 'x-1', ...context });
  for (const [message, code] of [
    ['Revision repeated without changed evidence; inspect and report before retrying', 'REVISION_REPEATED'],
    ['Revision must return to requirements-fix', 'REVISION_TARGET'],
    ['Resolve the previous stage before selecting another: requirements-fix returned waiting/REVIEW_REQUIRED', 'PREVIOUS_UNRESOLVED'],
    ['Previous stage has no usable result: requirements-fix is failed without a recorded result', 'PREVIOUS_RESULT_MISSING'],
    ['Dependency incomplete: requirements-fix', 'DEPENDENCY_INCOMPLETE'],
    ['User revision cannot start while another stage is running', 'USER_REVISION_REFUSED'],
    ['User revision requires a completed stage or one waiting on its question', 'USER_REVISION_REFUSED'],
    ['Native stage must be bound to the actual subagent ID', 'NOT_BOUND'],
    ['The active independent review belongs to a different stage execution', 'REVIEW_EXECUTION_MISMATCH'],
    ['Only the bound plan or contract stage worker can request a writer before submitting its result', 'DRAFT_HANDOFF_REFUSED'],
    ['Native stage must have a bound worker before assigning a writer', 'NOT_BOUND'],
    ['Native subagent binding mismatch', 'BIND_MISMATCH'],
    ['Stage already running; check the native subagent before retrying', 'STAGE_RUNNING'],
    ['aggregate-design cannot start before domain-model: the flow runs a in order, and domain-model is failed/EXECUTION_ERROR, not completed/OK. Complete domain-model next.', 'STAGE_ORDER'],
    ['Running stage cannot be verified stopped: the orchestrator Codex session is still open; close it first', 'RESTART_REFUSED'],
    ['PERMISSION_REQUIRED: the Harness subagent hook in /x/hooks.json is not trusted; open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop. Stages do not start without it.', 'HOOK_NOT_TRUSTED'],
    ['Command failed: git commit -m x', 'COMMIT_BLOCKED'],
    ['Result rejected: Questions require a waiting decision or review', 'RESULT_REJECTED'],
    ['Skill instruction is missing: requirements-fix', 'INSTALL_OR_BINDING'],
    ['tracker-publish requires completed/OK tactical design stage domain-model', 'STAGE_ORDER'],
    ['Publication approval answer was not recorded: no user message after the reviewed plan set contains it', 'PRECONDITION'],
    ['tactical-code needs --plan <ticket-id>: the orchestrator assigns the next ready ticket (ready_tickets in harness-context.mjs)', 'PLAN_ARGUMENT'],
    ['tactical-code post-write cannot start before its prerequisite ticket auth is completed; ready tickets: auth', 'TICKET_ORDER'],
    ['Ticket auth is already completed; ready tickets: none', 'TICKET_ORDER'],
  ]) {
    const body = explain(message);
    assert.equal(body.code, code, message);
    assert.equal(body.error, message);
    assertActionable(body);
  }
  assert.ok(explain('Revision repeated without changed evidence; inspect and report before retrying').user_decision, 'a repeated revision is the user\'s decision');
  assert.ok(explain('PERMISSION_REQUIRED: the Harness subagent hook in /x is missing; run setup with the codex provider').user_decision);
  assert.match(explain('Previous stage has no usable result: requirements-fix is failed without a recorded result', { stageId: 'to-ticket' }).next.join('\n'), /launch --stage-id requirements-fix --feedback/);
  assert.match(explain('Something nobody planned for').next.join('\n'), /Do not read Harness source/);
  assert.deepEqual(extractVerbose(['--stage-id', 'x', '--verbose']), { args: ['--stage-id', 'x'], verbose: true });
  assert.deepEqual(extractVerbose(['--verbose', 'true', '--stage-id', 'x']), { args: ['--stage-id', 'x'], verbose: true });
  assert.deepEqual(extractVerbose(['--stage-id', 'x']), { args: ['--stage-id', 'x'], verbose: false });
});

test('finish preserves harness-result stdout, stderr, exit status and signal when recording fails', async (t) => {
  const { workspace, beginStage, submitStage, finishStage, specPath } = await consumerWorkflow(t, REQUEST);
  const begun = await beginStage('stakeholder-analysis');
  await submitStage(begun, SKIPPED(specPath('stakeholder-analysis.md')));

  await writeFile(join(workspace, '.harness/scripts/harness-result.mjs'), "process.stdout.write('fixture stdout\\n'); process.exitCode = 23;\n");
  const result = await finishStage(begun);
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stderr);
  assert.equal(body.code, 'RESULT_REJECTED');
  assert.match(body.why, /status 23/);
  assert.equal(body.result_command.exit_code, 23);
  assert.equal(body.result_command.signal, null);
  assert.equal(body.result_command.spawn_error, null);

  const stdoutPath = join(workspace, '.io', body.result_command.stdout_path);
  const stderrPath = join(workspace, '.io', body.result_command.stderr_path);
  const metadataPath = join(workspace, '.io', body.result_command.process_path);
  assert.equal(await readFile(stdoutPath, 'utf8'), 'fixture stdout\n');
  assert.equal(await readFile(stderrPath, 'utf8'), '');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.ok(Number.isInteger(metadata.pid) && metadata.pid > 0);
  assert.equal(metadata.exit_code, 23);
  assert.equal(metadata.signal, null);
  assert.deepEqual(metadata.command.slice(1, 2), [join(workspace, '.harness/scripts/harness-result.mjs')]);
});

test('launch preserves prepare spawn failures and signals, then recovers an exact input when prepare exits with empty stdout', async (t) => {
  const { workspace, tree, treeGit } = await consumerWorkflow(t, REQUEST);
  const io = join(workspace, '.io');
  const stage = 'stakeholder-analysis';
  const args = ['launch', '--stage-id', stage];
  const preparePath = join(workspace, '.harness/scripts', PREPARE);
  const originalPrepare = await readFile(preparePath, 'utf8');
  const wrapper = join(io, 'missing-executable.cjs');
  const missingExecutable = join(io, 'nonexistent-node');
  await writeFile(wrapper, `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(missingExecutable)} });\n`);
  const failedSpawn = refusal(spawnSync(process.execPath, ['--require', wrapper, join(workspace, '.harness/scripts', NATIVE), ...args], { cwd: workspace, encoding: 'utf8' }), 'LAUNCH_CHILD_FAILED');
  assert.equal(failedSpawn.launch_command.exit_code, null);
  assert.equal(failedSpawn.launch_command.signal, null);
  assert.equal(failedSpawn.launch_command.spawn_error.code, 'ENOENT');
  assert.equal(failedSpawn.prepared_execution_id, undefined);
  const spawnEvidence = JSON.parse(await readFile(join(io, failedSpawn.launch_command.process_path), 'utf8'));
  assert.deepEqual(spawnEvidence, failedSpawn.launch_command);

  await writeFile(preparePath, "process.kill(process.pid, 'SIGTERM');\n");
  const signalled = refusal(exec(workspace, NATIVE, args), 'LAUNCH_CHILD_FAILED');
  assert.equal(signalled.launch_command.signal, 'SIGTERM');
  assert.equal(signalled.launch_command.exit_code, null);
  assert.equal(signalled.launch_command.spawn_error, null);
  assert.equal(signalled.prepared_execution_id, undefined);

  await writeFile(preparePath, originalPrepare.replace(/  process\.stdout\.write\(`\$\{JSON\.stringify\(verbose \? prepared : compactPrepared\(prepared\)\)\}.*\);/, "  process.stderr.write('prepare fixture diagnostic\\n');"));
  const noOutput = refusal(exec(workspace, NATIVE, args), 'LAUNCH_RESULT_MISSING');
  assert.equal(noOutput.launch_command.exit_code, 0);
  assert.equal(noOutput.launch_command.stdout_bytes, 0);
  assert.equal(await readFile(join(io, noOutput.launch_command.stdout_path), 'utf8'), '');
  assert.equal(await readFile(join(io, noOutput.launch_command.stderr_path), 'utf8'), 'prepare fixture diagnostic\n');
  assert.match(noOutput.prepared_execution_id, /^stakeholder-analysis-/);
  assert.deepEqual(await readdir(join(io, tree.plan_set_id, stage)), [noOutput.prepared_execution_id]);
  const statePath = join(io, 'runtime/orchestrator/state.json');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stages[stage], undefined);
  assert.deepEqual(noOutput.next, [`node .harness/scripts/${NATIVE} start --execution-id ${noOutput.prepared_execution_id}`]);
  ok(runPrinted(workspace, noOutput.next[0]));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stages[stage].execution_id, noOutput.prepared_execution_id);
  assert.equal(treeGit('status', '--short', '-uall'), '');
});

test('launch diagnoses malformed start output without restarting an existing claim and retains bounded child evidence', async (t) => {
  const { workspace } = await consumerWorkflow(t, REQUEST);
  const io = join(workspace, '.io');
  const nativePath = join(workspace, '.harness/scripts', NATIVE);
  const originalNative = await readFile(nativePath, 'utf8');
  await writeFile(nativePath, originalNative.replace("process.stdout.write(`${JSON.stringify(verbose ? started : compactStarted(started, { executionId: id }))}\\n`);", "process.stdout.write('x'.repeat(80 * 1024) + '\\n{truncated json');"));
  const failure = refusal(exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']), 'LAUNCH_RESULT_MISSING');
  assert.equal(failure.launch_command.phase, 'start');
  assert.equal(failure.launch_command.exit_code, 0);
  assert.equal(failure.launch_command.stdout_truncated, true);
  const stdout = await readFile(join(io, failure.launch_command.stdout_path));
  assert.equal(stdout.length, 64 * 1024);
  assert.match(stdout.toString(), /\{truncated json$/);
  assert.deepEqual(failure.next, [`node .harness/scripts/${NATIVE} inspect --execution-id ${failure.prepared_execution_id}`]);
  assert.equal(ok(runPrinted(workspace, failure.next[0])).execution_id, failure.prepared_execution_id);
});

test('launch preserves the child refusal when writing evidence is unsafe', async (t) => {
  const { workspace } = await consumerWorkflow(t, REQUEST);
  const outside = join(dirname(workspace), 'outside-launch-evidence');
  await mkdir(outside);
  await symlink(outside, join(workspace, '.io/runtime/launch-attempts'));
  const result = refusal(exec(workspace, NATIVE, ['launch', '--stage-id', 'event-storming']), 'STAGE_ORDER');
  assert.equal(result.launch_command.exit_code, 1);
  assert.match(result.launch_command.evidence_error, /must not be a symlink/);
  assert.equal(result.launch_command.process_path, undefined);
  assert.deepEqual(await readdir(outside), []);
});

test('the orchestrator and the dispatch guide name launch, the compact output and the rule against reading Harness source', async () => {
  const skill = await readFile(join(sourceRoot, '.codex/skills/orchestrator/SKILL.md'), 'utf8');
  assert.match(skill, /harness-native-stage\.mjs launch --stage-id <stage>/);
  assert.match(skill, /`next\.bind`/);
  assert.match(skill, /`harness-stage: <stage> \[launch 옵션\]`/);
  assert.match(skill, /stage마다 `Agent` 한 번만 호출한다/);
  assert.match(skill, /reference와 result 파일은 열지 않고/);
  assert.doesNotMatch(skill, /\]\(references\//);
  assert.match(skill, /harness-stage: revise/);
  assert.match(skill, /harness-native-stage\.mjs answer --text/);
  assert.match(skill, /Harness 소스·state 파일은 읽지 않는다/);
  const dispatch = await readFile(join(sourceRoot, '.codex/skills/orchestrator/references/dispatch.md'), 'utf8');
  assert.match(dispatch, /harness-native-stage\.mjs launch --stage-id <stage>/);
  assert.match(dispatch, /`--verbose`/);
  assert.match(dispatch, /`why`/);
  const enforcement = await readFile(join(sourceRoot, 'docs/architecture/enforcement.md'), 'utf8');
  assert.match(enforcement, /stage-cli\.mjs/);
});

test('a Claude launch names the model and effort for Agent and one command that binds and finishes; Codex keeps its own steps', () => {
  const claude = { agent_profile: 'workflow_stage', binding: { provider: 'claude-code', model: 'sonnet', reasoning_effort: 'low' } };
  assert.match(spawnInstruction(claude), /subagent_type "workflow_stage", model: "sonnet", effort: "low" and without the parent conversation, in the foreground/);
  assert.doesNotMatch(spawnInstruction({ ...claude, binding: { ...claude.binding, reasoning_effort: 'minimal' } }), /effort/, 'an effort Agent does not accept is not passed');
  const prepared = { input: { execution_id: 'e-1', skill: 'event-storming', context: {} } };
  const launched = launchResult({ prepared, started: { ...claude, execution_id: 'e-1', guide: 'g', input_path: 'i', schema_path: 's' } });
  assert.match(launched.next.spawn, /effort: "low"/);
  assert.equal(launched.next.after_agent, `${launched.next.bind} && ${launched.next.finish}`);
  const codex = launchResult({ prepared, started: { agent_profile: 'workflow_stage', binding: { provider: 'codex', model: 'm', reasoning_effort: 'low' }, execution_id: 'e-1' } });
  assert.equal(codex.next.after_agent, undefined);
  assert.match(codex.next.spawn, /fork_turns: "none"/);
});

test('finish carries the compact questions, so no result file is opened', () => {
  const questions = [{ question_id: 'e:1', title: '무엇을?', recommended_option_id: 'b', context: { settled_rules: ['r1', 'r2'], why_now: 'w' }, options: [{ id: 'a', label: 'A', consequence: 'ca', effect: 'ea', example: 'xa' }, { id: 'b', label: 'B', consequence: 'cb', effect: 'eb'.padEnd(300, 'b'), example: 'xb' }] }];
  const envelope = { status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: 'runtime/executions/e/result.json', result: { summary: '질문', artifacts: [], questions } };
  const finished = compactFinished({ envelope, stageId: 'event-storming', executionId: 'e' });
  const [shown] = finished.result.questions;
  assert.deepEqual(shown.context, ['w', 'r1'], 'at most two context lines: why now and the first settled rule');
  assert.deepEqual(shown.options.map(({ id, label, recommended }) => ({ id, label, recommended })), [{ id: 'a', label: 'A', recommended: undefined }, { id: 'b', label: 'B', recommended: true }]);
  assert.ok(shown.options[1].effect.length <= 200 && shown.options[1].effect.startsWith('eb'), 'the effect is one clipped line');
  assert.equal(finished.result.questions_path, undefined);
  assert.equal(shown.options[0].consequence, undefined, 'consequence stays in the result file');
  assert.deepEqual(shown.options.map((option) => option.example), ['xa', 'xb'], 'each option shows its one-line example');
  assert.equal(shown.reason, undefined, 'no rationale, no reason');
  assert.equal(compactQuestions([{ ...questions[0], rationale: '이유 한 줄' }])[0].reason, '이유 한 줄');
  assert.match(finished.next, /answer --text/);
  assert.match(compactFinished({ envelope, stageId: 'event-storming', executionId: 'e', provider: 'claude-code' }).next, /harness-stage: answer/);
});

// The orchestrator of a real Codex run ran `receive` with nothing on standard input twice (tactical-data worker, final message
// present and valid) and got "Native subagent output is empty"; a bound worker's missing output was a FORMAT_ERROR.
test('installed consumer: a missing worker or output is explained, and a bare receive reads a completed Codex worker\'s final JSON from its transcript', async (t) => {
  const { workspace, tree, treeGit, specPath, submitStage } = await consumerWorkflow(t, REQUEST);
  const analysis = specPath('stakeholder-analysis.md');
  const parentId = JSON.parse(await readFile(tree.worktree_ref, 'utf8')).agent_sessions.orchestrator.session_id;
  const launched = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']));
  const id = launched.execution_id;
  assert.match(launched.next.spawn, /spawn_agent \{agent_type: "workflow_stage", fork_turns: "none"\}/);

  // finish with no worker at all: the answer says to start the fresh worker (with fork_turns "none") and then bind it.
  const unbound = refusal(runPrinted(workspace, launched.next.finish), 'NOT_BOUND');
  assert.match(unbound.next[0], /Spawn the fresh worker .*fork_turns: "none"/);
  const agent = '/root/analysis_worker';
  ok(runPrinted(workspace, launched.next.bind, agent));

  // finish before the worker submitted anything is not a schema error.
  const early = runPrinted(workspace, launched.next.finish);
  assert.equal(early.status, 1);
  const missing = JSON.parse(early.stdout);
  assert.equal(missing.status, 'output_missing');
  assert.equal(missing.code, 'WORKER_OUTPUT_MISSING');
  assert.equal(missing.errors[0].missing, true);
  assert.equal(missing.receive_command, `node .harness/scripts/${NATIVE} receive --execution-id ${id} --agent-id '${agent}'`);
  assertActionable(missing);
  assert.doesNotMatch(JSON.stringify(missing), /FORMAT_ERROR|format_error/);

  // The stage result exactly as a worker returns it as its final message; the worker never submitted it.
  await submitStage({ stage: 'stakeholder-analysis', started: launched }, SKIPPED(analysis));
  const final = JSON.stringify(JSON.parse(await readFile(launched.output_path, 'utf8')));
  await unlink(launched.output_path);

  const sessions = join(process.env.CODEX_HOME, 'sessions');
  const childId = randomUUID();
  const childFile = rolloutPath(sessions, childId);
  const child = childRollout({ parentId, childId, cwd: workspace, agentPath: agent });
  await writeRollout(rolloutPath(sessions, parentId), parentRollout({ parentId, cwd: workspace, childId, agentPath: agent }));
  const receive = (env = {}) => spawnSync(process.execPath, [join(workspace, '.harness/scripts', NATIVE), 'receive', '--execution-id', id, '--agent-id', agent], { cwd: workspace, encoding: 'utf8', input: '', env: { ...process.env, ...env } });
  const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const attestationFile = join(workspace, '.io/runtime/executions', id, 'native-attestation.jsonl');
  const attestations = async () => (await readFile(attestationFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((row) => JSON.parse(row));

  // No transcript to read, or not the orchestrator conversation: the empty command says where the JSON belongs.
  await writeRollout(childFile, child.stoppedRows);
  const noPipe = refusal(receive({ CODEX_THREAD_ID: other }), 'RECEIVE_INPUT_EMPTY');
  assert.match(noPipe.next.join('\n'), /printf %s '<final JSON>' \| node \.harness\/scripts\/harness-native-stage\.mjs receive/);
  assert.equal(existsSync(launched.output_path), false, 'nothing was recorded');

  // The worker's turn is still running; the SubagentStop hook fires before task_complete exists and cannot capture the turn.
  refusal(receive({ CODEX_THREAD_ID: parentId }), 'WORKER_NOT_FINISHED');
  await writeRollout(childFile, [...child.stoppedRows, ...child.finalRows(final)]);
  const stop = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-agent-event.mjs')], { cwd: workspace, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '' },
    input: JSON.stringify({ hook_event_name: 'SubagentStop', cwd: workspace, session_id: parentId, agent_id: childId, agent_type: 'workflow_stage', agent_transcript_path: childFile }) });
  assert.equal(stop.status, 0, stop.stderr);
  const hookTime = await attestations();
  assert.equal(hookTime.length, 1);
  assert.deepEqual([hookTime[0].status, hookTime[0].reason, hookTime[0].source], ['unavailable', 'completed_turn_metadata_missing', 'codex-subagent-stop-hook']);
  refusal(receive({ CODEX_THREAD_ID: parentId }), 'WORKER_NOT_FINISHED');

  // A turn that completed without any JSON, with a failure or with an interruption each has its own recovery.
  const recovery = (body) => body.next.join('\n');
  await writeRollout(childFile, [...child.stoppedRows, child.completeRow(null)]);
  const empty = refusal(receive({ CODEX_THREAD_ID: parentId }), 'NATIVE_OUTPUT_EMPTY');
  assert.match(recovery(empty), new RegExp(`${NATIVE} fail --execution-id ${id} --reason`));
  assert.match(recovery(empty), /launch --stage-id stakeholder-analysis --feedback/);
  await writeRollout(childFile, [...child.stoppedRows, child.completeRow('The analysis is done and saved.')]);
  assert.match(refusal(receive({ CODEX_THREAD_ID: parentId }), 'NATIVE_OUTPUT_EMPTY').why, /final message holds no JSON object/);
  await writeRollout(childFile, [...child.stoppedRows, child.failedRow('model overloaded')]);
  assert.match(recovery(refusal(receive({ CODEX_THREAD_ID: parentId }), 'WORKER_FAILED')), /--reason 'model overloaded'/);
  await writeRollout(childFile, [...child.stoppedRows, child.abortedRow()]);
  assert.match(recovery(refusal(receive({ CODEX_THREAD_ID: parentId }), 'WORKER_INTERRUPTED')), /recover-interrupted/);
  assert.equal(existsSync(launched.output_path), false, 'no refusal recorded anything');

  // The completed worker's final JSON is recorded from its own transcript; finish then records the stage and its completed turn.
  await writeRollout(childFile, [...child.stoppedRows, ...child.finalRows(final), child.completeRow(final)]);
  const received = JSON.parse(receive({ CODEX_THREAD_ID: parentId }).stdout);
  assert.deepEqual(received, { status: 'received', execution_id: id, source: 'native_transcript', thread_id: childId });
  assert.equal(await readFile(launched.output_path, 'utf8'), final);
  const again = JSON.parse(receive({ CODEX_THREAD_ID: parentId }).stdout);
  assert.equal(again.status, 'received', 'a bare receive repeats safely while the worker output is the same');
  const finished = ok(runPrinted(workspace, launched.next.finish));
  assert.equal(finished.code, 'OK');
  const rows = await attestations();
  assert.equal(rows.at(-1).status, 'captured', 'finish captured the completed turn the hook could not');
  assert.equal(rows.at(-1).source, 'codex-finish-transcript-refresh');
  assert.deepEqual(rows.at(-1).turns, [{ turn_id: 'turn-child-1', status: 'completed', model: 'gpt-6-luna', reasoning_effort: 'medium' }]);
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [analysis]);
  assert.equal(treeGit('status', '--short', '--untracked-files=all'), '');
});

test('installed consumer: a worker that completed without a result is recorded as failed and the same stage is relaunched with the printed commands', async (t) => {
  const { workspace, tree } = await consumerWorkflow(t, REQUEST);
  const parentId = JSON.parse(await readFile(tree.worktree_ref, 'utf8')).agent_sessions.orchestrator.session_id;
  const launched = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'stakeholder-analysis']));
  const id = launched.execution_id;
  const agent = '/root/analysis_worker';
  ok(runPrinted(workspace, launched.next.bind, agent));
  const sessions = join(process.env.CODEX_HOME, 'sessions');
  const childId = randomUUID();
  const child = childRollout({ parentId, childId, cwd: workspace, agentPath: agent });
  await writeRollout(rolloutPath(sessions, parentId), parentRollout({ parentId, cwd: workspace, childId, agentPath: agent }));
  await writeRollout(rolloutPath(sessions, childId), [...child.stoppedRows, child.completeRow(null)]);
  const receive = spawnSync(process.execPath, [join(workspace, '.harness/scripts', NATIVE), 'receive', '--execution-id', id, '--agent-id', agent], { cwd: workspace, encoding: 'utf8', input: '', env: { ...process.env, CODEX_THREAD_ID: parentId } });
  const body = refusal(receive, 'NATIVE_OUTPUT_EMPTY');
  const sh = (command) => spawnSync('sh', ['-c', command.replace('<actual reason or user instruction>', 'The previous worker ended with an empty final message')], { cwd: workspace, encoding: 'utf8' });
  const fail = body.next.find((step) => step.includes(`${NATIVE} fail --execution-id ${id}`)).replace(/^.*?(node \.harness)/, '$1');
  const failed = ok(sh(fail));
  assert.equal(failed.status, 'failed');
  const relaunch = body.next.find((step) => step.includes('launch --stage-id stakeholder-analysis --feedback')).replace(/^.*?(node \.harness)/, '$1');
  const relaunched = ok(sh(relaunch));
  assert.equal(relaunched.status, 'launched');
  assert.notEqual(relaunched.execution_id, id);
  assert.equal(JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8')).stages['stakeholder-analysis'].execution_id, relaunched.execution_id);
});
