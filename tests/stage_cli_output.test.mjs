import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { explainError, extractVerbose } from '../.harness/src/workflow/stage-cli.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const NATIVE = 'harness-native-stage.mjs';
const PREPARE = 'harness-prepare-input.mjs';
const bytes = (text) => Buffer.byteLength(text);
const exec = (workspace, script, args = [], input) => spawnSync(process.execPath, [join(workspace, '.codex/scripts', script), ...args], { cwd: workspace, encoding: 'utf8', input });
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
// Runs a printed `node .codex/scripts/<script> ...` command the way the orchestrator does, filling the agent placeholder.
const runPrinted = (workspace, command, agentId = 'agent-1') => {
  const parts = command.replace('<agent_id>', agentId).split(' ');
  assert.equal(parts[0], 'node', command);
  return spawnSync(process.execPath, parts.slice(1), { cwd: workspace, encoding: 'utf8' });
};
const SKIP = (analysis) => `생략: stakeholder-analysis 판정 생략 (${analysis})`;
const SKIPPED = (analysis) => ({ files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
const question = { question_id: 'q-1', title: '삭제한 글을 복구할 수 있나요?', options: [{ id: 'no', label: '복구할 수 없다', consequence: '삭제는 되돌릴 수 없다', evidence: [] }, { id: 'yes', label: '복구할 수 있다', consequence: '삭제 상태를 보관한다', evidence: [] }], recommended_option_id: 'no', rationale: '요구사항이 그렇게 말한다', decision_kind: null };

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
  assert.equal(prepared.next, `node .codex/scripts/${NATIVE} start --execution-id ${prepared.execution_id}`);
  assert.ok(bytes(compact.stdout) <= 500, `prepare is ${bytes(compact.stdout)} bytes`);
  assert.ok(bytes(compact.stdout) * 3 < bytes(full.stdout), 'prepare is a third of its verbose size or less');

  // start: what spawn_agent needs and the bind command, without the workspace, the sandbox or the binding's skill.
  const startOutput = exec(workspace, NATIVE, ['start', '--execution-id', prepared.execution_id]);
  const started = ok(startOutput);
  assert.deepEqual(Object.keys(started).sort(), ['agent_profile', 'binding', 'guide', 'input_path', 'next', 'output_path', 'schema_path']);
  assert.equal(started.agent_profile, 'workflow_stage');
  assert.deepEqual(Object.keys(started.binding).sort(), ['model', 'model_tier', 'provider', 'reasoning_effort']);
  for (const path of [started.guide, started.input_path, started.schema_path]) assert.ok(existsSync(path), path);
  assert.match(started.next, new RegExp(`bind --execution-id ${prepared.execution_id} --agent-id <agent_id>$`));
  assert.ok(bytes(startOutput.stdout) <= 1500, `start is ${bytes(startOutput.stdout)} bytes`);

  // bind and finish.
  const bound = ok(exec(workspace, NATIVE, ['bind', '--execution-id', prepared.execution_id, '--agent-id', 'agent-1']));
  assert.deepEqual(bound, { status: 'running', execution_id: prepared.execution_id, agent_id: 'agent-1' });
  await submitStage({ stage, started }, { summary: SKIP(analysis) });
  const finishOutput = exec(workspace, NATIVE, ['finish', '--execution-id', prepared.execution_id]);
  const finished = ok(finishOutput);
  assert.deepEqual(Object.keys(finished), ['status', 'code', 'execution_id', 'stage_id', 'result_ref', 'result', 'next']);
  assert.deepEqual(Object.keys(finished.result), ['summary', 'artifacts']);
  assert.equal(finished.result.summary, SKIP(analysis));
  assert.ok(bytes(finishOutput.stdout) <= 700, `finish is ${bytes(finishOutput.stdout)} bytes`);
  assert.match(finished.next, /next stage/);

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
  const lock = JSON.parse(await readFile(join(primary, '.codex/harness-lock.json'), 'utf8'));
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
  assert.equal(launched.next.bind, `node .codex/scripts/${NATIVE} bind --execution-id ${launched.execution_id} --agent-id <agent_id>`);
  assert.equal(launched.next.finish, `node .codex/scripts/${NATIVE} finish --execution-id ${launched.execution_id}`);
  assert.ok(bytes(output.stdout) <= 1700, `launch is ${bytes(output.stdout)} bytes`);
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
  for (const path of ['.harness/src/workflow/stage-cli.mjs', '.codex/scripts/harness-native-stage.mjs', '.io/runtime/orchestrator/state.json']) assert.match(treeGit('check-ignore', '-v', path), /exclude/, path);
  assert.equal(primaryGit('status', '--short', '--untracked-files=all').trim(), '');

  // The next stage launches from the compact transition, again in one call.
  const next = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'subdomain-candidates']));
  assert.equal(next.from_stage, 'stakeholder-analysis');
  assert.equal(next.from_code, 'OK');
  await submitStage({ stage: 'subdomain-candidates', started: next }, { summary: SKIP(analysis) });
  const bound = runPrinted(workspace, next.next.bind);
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(ok(runPrinted(workspace, next.next.finish)).status, 'completed');

  // A launch that needs the user instead of a new run (a partial answer batch) reports it and starts nothing.
  const asked = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'ubiquitous-language']));
  ok(runPrinted(workspace, asked.next.bind));
  await submitStage({ stage: 'ubiquitous-language', started: asked }, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', questions: [question] });
  const waiting = ok(runPrinted(workspace, asked.next.finish));
  assert.equal(waiting.code, 'USER_DECISION_REQUIRED');
  assert.equal(waiting.result.questions[0].title, question.title, 'the question is relayed whole');
  assert.match(waiting.next, /launch --stage-id ubiquitous-language --answer /);
  const resumed = ok(exec(workspace, NATIVE, ['launch', '--stage-id', 'ubiquitous-language', '--answer', 'no']));
  assert.equal(resumed.status, 'launched');
  assert.equal(resumed.answered, true);
  assert.equal(treeGit('status', '--short', '--untracked-files=all').replace(/^ M app\.txt\n?/m, '').trim(), '');
});

test('update restores the output module of an installed consumer and Doctor requires it', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { primary } = flow;
  const module = '.harness/src/workflow/stage-cli.mjs';
  const git = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;
  await unlink(join(primary, module));
  const lockPath = join(primary, '.codex/harness-lock.json');
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
  assert.equal(order.next[0], `node .codex/scripts/${NATIVE} launch --stage-id stakeholder-analysis`);
  assert.equal(refusal(exec(workspace, NATIVE, ['launch', '--stage-id', 'event-storming']), 'STAGE_ORDER').next[0], order.next[0], 'launch passes the explained refusal on unchanged');

  // Arguments and workspace.
  refusal(exec(workspace, PREPARE, ['--stage-id']), 'INVALID_ARGUMENT');
  refusal(exec(workspace, NATIVE, ['finish']), 'INVALID_ARGUMENT');
  refusal(exec(workspace, PREPARE, ['--stage-id', 'tracker-publish']), 'PRECONDITION');
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
  assert.equal(unbound.next[0], `node .codex/scripts/${NATIVE} bind --execution-id ${id} --agent-id <agent_id>`);
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
  const unusable = refusal(exec(workspace, PREPARE, ['--stage-id', 'to-ticket']), 'PREVIOUS_RESULT_MISSING');
  assert.match(unusable.error, /subdomain-candidates is running/);
  assert.match(ids(unusable), new RegExp(`finish --execution-id ${flowRun.execution_id}`));
  ok(runPrinted(workspace, flowRun.next.bind));
  await submitStage({ stage: 'subdomain-candidates', started: flowRun }, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', questions: [question] });
  ok(runPrinted(workspace, flowRun.next.finish));
  const unresolved = refusal(exec(workspace, PREPARE, ['--stage-id', 'to-ticket']), 'PREVIOUS_UNRESOLVED');
  assert.ok(unresolved.user_decision, 'the question is the user\'s');
  assert.match(ids(unresolved), /launch --stage-id subdomain-candidates --answer/);
  const waitingOrder = refusal(exec(workspace, PREPARE, ['--stage-id', 'ubiquitous-language']), 'STAGE_ORDER');
  assert.ok(waitingOrder.user_decision, 'a waiting stage in the way is answered, not skipped');
});

test('the explanation catalogue covers the errors the stage commands throw and each explanation leaves a next step', async () => {
  const files = ['.harness/src/workflow/stage-input.mjs', '.harness/src/workflow/requirements-restart.mjs', '.harness/src/workflow/stage-takeover.mjs', '.harness/src/workflow/execution-state.mjs', '.harness/src/workflow/worktree-stages.mjs', '.codex/scripts/harness-prepare-input.mjs', '.codex/scripts/harness-native-stage.mjs', '.harness/src/workflow/cli-context.mjs', '.harness/src/workflow/execution-input.mjs'];
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
    const body = explainError(new Error(message), { root: join(sourceRoot, 'no-such-workspace'), stageId: 'spec-me', executionId: 'x-1' });
    assertActionable(body);
    if (body.code === 'HARNESS_ERROR' && !INTEGRITY.test(message)) generic.push(message);
  }
  assert.deepEqual(generic, [], 'every error the orchestrator can act on has an explanation; add a rule (or list an integrity failure)');

  // The refusals that cannot be provoked on a clean consumer, each with its own explanation.
  const explain = (message, context = {}) => explainError(new Error(message), { root: join(sourceRoot, 'no-such-workspace'), stageId: 'spec-me', executionId: 'x-1', ...context });
  for (const [message, code] of [
    ['Revision repeated without changed evidence; inspect and report before retrying', 'REVISION_REPEATED'],
    ['Revision must return to requirements-fix', 'REVISION_TARGET'],
    ['Resolve the previous stage before selecting another: spec-me returned waiting/REVIEW_REQUIRED', 'PREVIOUS_UNRESOLVED'],
    ['Previous stage has no usable result: spec-me is failed without a recorded result', 'PREVIOUS_RESULT_MISSING'],
    ['Dependency incomplete: spec-me', 'DEPENDENCY_INCOMPLETE'],
    ['User revision cannot start while another stage is running', 'USER_REVISION_REFUSED'],
    ['User revision requires a completed stage or one waiting on its question', 'USER_REVISION_REFUSED'],
    ['Native stage must be bound to the actual subagent ID', 'NOT_BOUND'],
    ['Native subagent binding mismatch', 'BIND_MISMATCH'],
    ['Stage already running; check the native subagent before retrying', 'STAGE_RUNNING'],
    ['spec-me cannot start before domain-model: the flow runs a in order, and domain-model is failed/EXECUTION_ERROR, not completed/OK. Complete domain-model next.', 'STAGE_ORDER'],
    ['Running stage cannot be verified stopped: the orchestrator Codex session is still open; close it first', 'RESTART_REFUSED'],
    ['PERMISSION_REQUIRED: the Harness subagent hook in /x/hooks.json is not trusted; open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop. Stages do not start without it.', 'HOOK_NOT_TRUSTED'],
    ['Command failed: git commit -m x', 'COMMIT_BLOCKED'],
    ['Result rejected: Questions require a waiting decision or review', 'RESULT_REJECTED'],
    ['Skill instruction is missing: spec-me', 'INSTALL_OR_BINDING'],
  ]) {
    const body = explain(message);
    assert.equal(body.code, code, message);
    assert.equal(body.error, message);
    assertActionable(body);
  }
  assert.ok(explain('Revision repeated without changed evidence; inspect and report before retrying').user_decision, 'a repeated revision is the user\'s decision');
  assert.ok(explain('PERMISSION_REQUIRED: the Harness subagent hook in /x is missing; run setup with the codex provider').user_decision);
  assert.match(explain('Previous stage has no usable result: spec-me is failed without a recorded result', { stageId: 'to-ticket' }).next.join('\n'), /launch --stage-id spec-me --feedback/);
  assert.match(explain('Something nobody planned for').next.join('\n'), /Do not read Harness source/);
  assert.deepEqual(extractVerbose(['--stage-id', 'x', '--verbose']), { args: ['--stage-id', 'x'], verbose: true });
  assert.deepEqual(extractVerbose(['--verbose', 'true', '--stage-id', 'x']), { args: ['--stage-id', 'x'], verbose: true });
  assert.deepEqual(extractVerbose(['--stage-id', 'x']), { args: ['--stage-id', 'x'], verbose: false });
});

test('the orchestrator and the dispatch guide name launch, the compact output and the rule against reading Harness source', async () => {
  const skill = await readFile(join(sourceRoot, '.codex/skills/orchestrator/SKILL.md'), 'utf8');
  assert.match(skill, /harness-native-stage\.mjs launch --stage-id <stage>/);
  assert.match(skill, /`next\.bind`/);
  assert.match(skill, /Harness 소스나 state 파일을 읽지 않고/);
  const dispatch = await readFile(join(sourceRoot, '.codex/internal-skills/skill-execution/references/dispatch.md'), 'utf8');
  assert.match(dispatch, /harness-native-stage\.mjs launch --stage-id <stage>/);
  assert.match(dispatch, /`--verbose`/);
  assert.match(dispatch, /`why`/);
  const enforcement = await readFile(join(sourceRoot, 'docs/architecture/enforcement.md'), 'utf8');
  assert.match(enforcement, /stage-cli\.mjs/);
});
