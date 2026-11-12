import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';
import { parseWorktreeRecord, resolveExecutionWorkspace } from './worktrees.mjs';
import { preparePublicationDrafts } from '../tracker/publication.mjs';
import { mergeAnswers } from './questions.mjs';
import { findExecutionInput, writeExecutionInput } from './execution-input.mjs';
import { assertExecutionStopped, processIdentity, recordExecutionState } from './execution-state.mjs';
import { parseYaml } from '../eval/yaml.mjs';
import { configuredProvider } from './providers/index.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { planRuntimePaths } from '../eval/plan-journal.mjs';
import { stageExecutionPaths } from './session-output.mjs';
import { loadNamedWorkflow } from './loader.mjs';
import { replayJsonlStream } from '../eval/journal.mjs';

// 완료된 계획 산출물을 사용자가 고치라고 지시한 경우에만 같은 session으로 다시 연다.
const USER_REVISION_STAGES = new Set(['spec-me', 'to-ticket', 'implement-wrapper']);
const REVISION_TARGETS = { SPEC_REVISION_REQUIRED: 'spec-me', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' };

async function hasPassingImplementationGate(root) {
  const directory = join(root, '.io/runtime/workflow-completion');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const name of await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const match = /^implement-wrapper-([a-f0-9]{40})\.jsonl$/.exec(name);
    if (!match) continue;
    const stream = await replayJsonlStream(join(directory, name), { streamId: `implement-wrapper:${match[1]}` });
    if (!stream.valid) continue;
    if (stream.events.some((event) => event.type === 'workflow_completion' && event.payload?.workflow_id === 'implement-wrapper' && event.payload?.completion_kind === 'feature_implemented' && event.payload?.state === 'completed' && event.payload?.final_workflow === false && event.payload?.head === head)) return true;
  }
  return false;
}

export async function assertPrStageReadiness({ root, state, stageId }) {
  if (!['plan-pr', 'integration-pr'].includes(stageId)) return;
  const trackerMode = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')).tracker?.mode;
  if (trackerMode !== 'github') throw new Error('Pull request authoring requires GitHub tracker mode');
  if (stageId === 'plan-pr' && (state.stages?.['tracker-publish']?.status !== 'completed' || state.stages?.['tracker-publish']?.code !== 'OK')) throw new Error('Plan PR requires completed approved tracker publication');
  if (stageId === 'integration-pr' && (state.stages?.['implement-wrapper']?.status !== 'completed' || state.stages?.['implement-wrapper']?.code !== 'OK' || state.stages?.['sync-contracts']?.status !== 'completed' || state.stages?.['sync-contracts']?.code !== 'OK' || !(await hasPassingImplementationGate(root)))) throw new Error('Integration PR requires passing non-final implementation and contract completion gates');
}

export async function resolveStageSkill({ root, stageId }) {
  const workflows = await readdir(join(root, '.codex/workflows'), { withFileTypes: true });
  const matches = [];
  for (const file of workflows) {
    if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) continue;
    const manifest = await loadNamedWorkflow(file.name, { root });
    matches.push(...manifest.stages.filter((stage) => stage.id === stageId && stage.role === 'pr_author'));
  }
  if (matches.length > 1) throw new Error(`Workflow stage is ambiguous: ${stageId}`);
  return matches[0] || { id: stageId, skill: stageId };
}

async function archiveToTicket({ root, session, planSetId, previousExecutionId, restartExecutionId }) {
  const restartRoot = join(session, 'runtime/restarts');
  await mkdir(restartRoot, { recursive: true });
  const lock = join(restartRoot, `${planSetId}.lock`);
  await mkdir(lock).catch((error) => { if (error.code === 'EEXIST') throw new Error('A to-ticket restart is already being prepared'); throw error; });
  try {
    const prefix = `${planSetId}-${previousExecutionId}-`;
    const names = await readdir(restartRoot);
    const pendingNames = names.filter((name) => name.startsWith(prefix) && name.endsWith('.pending'));
    for (const name of pendingNames) {
      const pending = join(restartRoot, name);
      const pendingInfo = await lstat(pending);
      if (!pendingInfo.isDirectory() || pendingInfo.isSymbolicLink()) throw new Error(`Invalid interrupted restart archive: ${pending}`);
      const destinations = { plans: join(root, 'docs/plans', planSetId), 'plan-review.json': join(session, 'runtime/reviews', `plan-${planSetId}.json`), 'to-ticket': join(session, 'runtime/to-ticket') };
      for (const item of await readdir(pending)) {
        if (item === 'restart.json') { await rm(join(pending, item), { force: true }); continue; }
        if (!destinations[item]) throw new Error(`Unknown interrupted restart archive item: ${item}`);
        const itemPath = join(pending, item), itemInfo = await lstat(itemPath);
        if ((!itemInfo.isDirectory() && !itemInfo.isFile()) || itemInfo.isSymbolicLink()) throw new Error(`Invalid interrupted restart item: ${itemPath}`);
        const target = destinations[item];
        if (await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error(`Cannot recover interrupted restart; original path exists: ${target}`);
        await mkdir(join(target, '..'), { recursive: true });
        await rename(join(pending, item), target);
      }
      await rm(pending, { recursive: true, force: true });
    }
    if (names.some((name) => name.startsWith(prefix) && !name.endsWith('.pending'))) throw new Error('This waiting to-ticket execution has already been restarted');
    const archive = join(restartRoot, `${prefix}${randomUUID()}`);
    const sources = [
      { path: join(root, 'docs/plans', planSetId), name: 'plans' },
      { path: join(session, 'runtime/reviews', `plan-${planSetId}.json`), name: 'plan-review.json' },
      { path: join(session, 'runtime/to-ticket'), name: 'to-ticket' },
    ];
    const moving = [];
    for (const source of sources) {
      const info = await lstat(source.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info?.isSymbolicLink() || (info && !info.isDirectory() && !info.isFile())) throw new Error(`Cannot archive invalid restart input: ${source.path}`);
      if (info) moving.push(source);
    }
    const pending = `${archive}.pending`;
    await mkdir(pending);
    try {
      for (const item of moving) {
        await mkdir(join(pending, item.name, '..'), { recursive: true });
        await rename(item.path, join(pending, item.name));
      }
      await writeFile(join(pending, 'restart.json'), `${JSON.stringify({ previous_execution_id: previousExecutionId, restart_execution_id: restartExecutionId }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(pending, archive);
    } catch (error) {
      await rm(join(pending, 'restart.json'), { force: true });
      for (const item of moving.toReversed()) {
        const from = join(pending, item.name);
        if (await lstat(from).catch((readError) => readError.code === 'ENOENT' ? null : Promise.reject(readError))) await rename(from, item.path);
      }
      await rm(pending, { recursive: true, force: true });
      throw error;
    }
    return archive;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function existingRestartInput({ root, session, planSetId, previousExecutionId, worktreeRef }) {
  const restartRoot = join(session, 'runtime/restarts');
  const prefix = `${planSetId}-${previousExecutionId}-`;
  const matches = (await readdir(restartRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((name) => name.startsWith(prefix) && !name.endsWith('.pending'));
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Multiple restart archives match the waiting to-ticket execution');
  const marker = JSON.parse(await readFile(join(restartRoot, matches[0], 'restart.json'), 'utf8'));
  if (marker.previous_execution_id !== previousExecutionId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(marker.restart_execution_id || '')) throw new Error('Restart archive identity is invalid');
  const found = await findExecutionInput(root, marker.restart_execution_id);
  const input = await readExecutionInput({ root, execution_id: marker.restart_execution_id });
  if (input.skill !== 'to-ticket' || input.context?.stage_id !== 'to-ticket' || input.context?.plan_set_id !== planSetId || input.context?.worktree_ref !== worktreeRef) throw new Error('Archived restart input does not match this worktree stage');
  await validateSkillInput({ root, input });
  const paths = stageExecutionPaths(root, marker.restart_execution_id);
  if (paths.session !== session) throw new Error('Restart input session does not match active worktree');
  return { input, path: found.path, session_directory: session, execution_directory: paths.directory };
}

function storedStageInput(input) {
  if (!input.context?.worktree_ref || !['spec-me', 'to-ticket', 'tracker-publish'].includes(input.skill)) return input;
  const { workspace_root, shared_guidance_root, session_directory, ...rest } = input;
  const { plan_set_id, ...context } = rest.context;
  return { ...rest, context };
}

async function collectAnswers(session, prefix, questions, answer) {
  let incoming;
  try { incoming = JSON.parse(answer); } catch { incoming = questions.length === 1 ? [{ question_id: questions[0].question_id, answer }] : null; }
  if (!Array.isArray(incoming) && questions.length === 1 && typeof incoming === 'string') incoming = [{ question_id: questions[0].question_id, answer: incoming }];
  const path = join(session, prefix, 'pending-answers.json');
  await assertWorkspaceTarget(session, path);
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) throw new Error('Pending answers must be a regular unshared file');
  let previous = [];
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(incoming)) throw new Error('Answers must be a JSON array');
  if (previous.length) incoming = incoming.filter((entry) => !previous.some((item) => item.question_id === entry.question_id && item.answer === entry.answer));
  const merged = mergeAnswers(questions, previous, incoming);
  if (merged.complete) {
    const decisionPath = join(session, prefix, 'decision-answers.json');
    const contents = JSON.stringify(merged.answers, null, 2) + '\n';
    await assertWorkspaceTarget(session, decisionPath);
    try { await writeFile(decisionPath, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(decisionPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error('Recorded decision answers differ or are not a regular unshared file');
      const recorded = await readFile(decisionPath, 'utf8');
      if (recorded !== contents) {
        let inputAnswers = null;
        try { inputAnswers = JSON.parse(await readFile(join(session, prefix, 'answers.json'), 'utf8')); }
        catch (readError) { if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError; }
        if (!Array.isArray(inputAnswers) || !isDeepStrictEqual(JSON.parse(recorded), inputAnswers)) throw new Error('Recorded decision answers differ or are not a regular unshared file');
        await writeFile(decisionPath, contents, { mode: 0o600 });
      }
    }
  }
  await writeFile(path, JSON.stringify(merged.answers, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

async function executionSession({ root, session, executionId, worktreeRef }) {
  let log = {};
  try { log = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${executionId}/exec.stderr.json` }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const previousInput = await readExecutionInput({ root, execution_id: executionId });
  const provider = log.provider || previousInput.context?.resume_provider || previousInput.context?.provider || 'codex';
  let session_id = log.session_id || log.thread_id || previousInput.context?.resume_session_id;
  if (session_id && previousInput.context?.resume_session_id && session_id !== previousInput.context.resume_session_id) throw new Error('Recorded provider session ID does not match resumed session');
  if (session_id && previousInput.context?.resume_provider && provider !== previousInput.context.resume_provider) throw new Error('Recorded provider does not match resumed session');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id || '')) {
    if (!worktreeRef) throw new Error(`${provider} session ID missing from execution log`);
    const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
    const matches = Object.values(record.agent_sessions || {}).filter((entry) => entry.execution_id === executionId);
    if (matches.length !== 1) throw new Error(`${provider} session ID missing or ambiguous in canonical worktree record`);
    session_id = matches[0].session_id;
    if (matches[0].provider && matches[0].provider !== provider) throw new Error('Canonical provider does not match execution log');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id || '')) throw new Error(`${provider} session ID missing from execution`);
  return { provider, session_id };
}

export async function prepareStageInput({ root, session, worktreeRef = null, workflowRef, stageId, codexSessionId, orchestratorSession = null, answer = null, feedback = null, reviewAdmissionRef = null, publicationApproved = false, specOverwriteApproved = false, restart = false, userRevision = false, planId = null, repairReceipt = null, approvalAnswer = null, e2eRequest = null, testDefectFailure = null }) {
  if (stageId === 'e2e-test' && !e2eRequest) throw new Error('E2E stage requires an approved request');
  if (stageId !== 'e2e-test' && e2eRequest) throw new Error('E2E request applies only to e2e-test');
  if (userRevision && (feedback === null || !USER_REVISION_STAGES.has(stageId))) throw new Error('User revision requires feedback for spec-me, to-ticket or implement-wrapper');
  if (userRevision && stageId === 'implement-wrapper' && (!planId || !repairReceipt || !approvalAnswer)) throw new Error('Implementation revision requires a plan, failure receipt and approval answer');
  if ((repairReceipt || approvalAnswer) && !(userRevision && stageId === 'implement-wrapper' && repairReceipt && approvalAnswer)) throw new Error('Repair receipt and approval answer require an implementation user revision');
  if (testDefectFailure && !(userRevision && stageId === 'implement-wrapper' && repairReceipt && approvalAnswer)) throw new Error('Test defect evidence requires an implementation revision');
  // implement-wrapper builds one plan the orchestrator assigns; it never chooses the plan itself.
  if (planId !== null && stageId !== 'implement-wrapper') throw new Error('--plan applies only to implement-wrapper');
  if (stageId === 'implement-wrapper' && planId === null && feedback === null && answer === null) throw new Error('implement-wrapper needs --plan <plan-id>: the orchestrator assigns the next ready plan');
  if (planId !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId)) throw new Error('Invalid plan ID');
  if (answer !== null && (typeof answer !== 'string' || !answer.trim())) throw new Error('User answer must not be empty');
  if (feedback !== null && (typeof feedback !== 'string' || !feedback.trim() || answer !== null || reviewAdmissionRef)) throw new Error('Invalid execution feedback');
  let provider = configuredProvider(parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')));
  let workflowBinding = null;
  let state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.schema_version !== 1 || state.stages?.['workflow-compose']?.status !== 'completed') throw new Error('Worktree preparation is incomplete');
  if (stageId === 'tracker-publish' && (!publicationApproved || state.stages?.['to-ticket']?.status !== 'completed' || state.stages?.['to-ticket']?.code !== 'OK')) throw new Error('Completed to-ticket and user publication approval are required');
  await assertPrStageReadiness({ root, state, stageId });
  if (publicationApproved && stageId !== 'tracker-publish') throw new Error('Publication approval is only valid for tracker-publish');
  // The shared contract describes the integrated result, so it is written only after every plan is implemented.
  if (stageId === 'sync-contracts' && (state.stages?.['implement-wrapper']?.status !== 'completed' || state.stages?.['implement-wrapper']?.code !== 'OK')) throw new Error('sync-contracts starts only after implement-wrapper completed every plan and the final E2E passed');
  if (specOverwriteApproved && stageId !== 'spec-me') throw new Error('Spec overwrite approval is only valid for spec-me');
  if (restart && (stageId !== 'to-ticket' || answer !== null || feedback !== null)) throw new Error('Restart applies only to to-ticket without an answer or feedback');
  const running = state.stages?.[stageId];
  if (running?.status === 'running' && !running.result_ref) {
    let stopped = false;
    await assertExecutionStopped(running, { root, session }); stopped = true;
    if (stopped) {
      const prefix = `runtime/executions/${running.execution_id}`;
      let envelope, log, result;
      try {
        log = await readSkillSessionJson({ root, session_directory: session, path: `${prefix}/exec.stderr.json` });
        result = await readSkillSessionJson({ root, session_directory: session, path: `${prefix}/result.json` });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { envelope = await readSkillSessionJson({ root, session_directory: session, path: `${prefix}/return.json` }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!envelope && result && log?.exit_code === 0) envelope = { schema_version: result.schema_version, execution_id: result.execution_id, skill: result.skill, status: result.status, code: result.code, result_ref: `${prefix}/result.json`, result };
      if (envelope && log?.exit_code === 0 && envelope.result_ref === `${prefix}/result.json`) {
        const previousInput = await readExecutionInput({ root, execution_id: running.execution_id });
        if (!result) throw new Error('Stored execution result is missing');
        for (const key of ['schema_version', 'execution_id', 'skill', 'status', 'code']) {
          if (result[key] !== envelope[key]) throw new Error(`Stored execution result ${key} does not match return`);
        }
        if (!isDeepStrictEqual(result, envelope.result)) throw new Error('Stored execution result does not match return');
        envelope.result = result;
        await validateSkillReturn({ root, input: previousInput, envelope });
        await writeFile(join(session, `${prefix}/return.json`), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
        await recordExecutionState({ root, input: previousInput, binding: log.binding || { model: running.model, reasoning_effort: running.reasoning_effort }, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref });
        state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
      }
    }
  }
  const prepared = await readExecutionInput({ root, execution_id: state.stages['workflow-compose'].execution_id });
  const stage = { ...await resolveStageSkill({ root, stageId }), scope: prepared.scope, needs: [], inputs: [], outputs: [], conditions: [], gates: [] };
  const input_refs = [];
  const producer_result_refs = {};
  let lastStage = state.current_stage;
  let last = lastStage && lastStage !== 'workflow-compose' ? state.stages?.[lastStage] : null;
  // A premature implementation dispatch can only be unblocked by publishing the reviewed plan.
  if (((stageId === 'tracker-publish' && publicationApproved) || (stageId === 'to-ticket' && userRevision)) && lastStage === 'implement-wrapper' && last?.status === 'blocked' && last.code === 'DEPENDENCY_INCOMPLETE' && !state.stages?.['tracker-publish']) {
    const blockedInput = await readExecutionInput({ root, execution_id: last.execution_id });
    const blockedReturn = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${last.execution_id}/return.json` });
    await validateSkillReturn({ root, input: blockedInput, envelope: blockedReturn });
    if (blockedReturn.status !== 'blocked' || blockedReturn.code !== last.code || blockedReturn.result_ref !== last.result_ref) throw new Error('Blocked implementation result does not match stage state');
    lastStage = 'to-ticket';
    last = state.stages[lastStage];
  }
  if (last?.code === 'SUBTASK_REQUIRED') throw new Error('Legacy SUBTASK_REQUIRED execution cannot be resumed: the pending subagent identity and result are not recorded; in-place recovery is unsupported. Preserve the session artifacts and report this limitation.');
  let transition;
  // 사용자 수정은 뒤 stage의 현재성을 요구하지 않는다. 그 stage가 고칠 Spec에 의존하므로 재검증하면 교착된다.
  // The user may also revise a completed Spec or plan while a later stage waits on a question: the revision replaces
  // that question (the later stage restarts from the revised plan), so it must not have to be answered first.
  const target = state.stages?.[stageId];
  const reopensCompletedWork = userRevision && target?.status === 'completed' && target.code === 'OK'
    && (last?.status === 'completed' && last.code === 'OK' || last?.status === 'waiting' && lastStage !== stageId || stageId === 'implement-wrapper' && lastStage === 'e2e-test' && ['failed', 'blocked', 'waiting'].includes(last?.status));
  if (!reopensCompletedWork && last && (lastStage !== stageId || Object.hasOwn(REVISION_TARGETS, last.code))) {
    if (!last.result_ref || !['completed', 'waiting'].includes(last.status)) throw new Error('Previous stage has no usable result');
    const allowed = REVISION_TARGETS;
    if (allowed[last.code] && allowed[last.code] !== stageId) throw new Error(`Revision must return to ${allowed[last.code]}`);
    if (!allowed[last.code] && last.code !== 'OK') throw new Error('Resolve the previous stage before selecting another');
    const priorInput = await readExecutionInput({ root, execution_id: last.execution_id });
    const priorReturn = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${last.execution_id}/return.json` });
    await validateSkillReturn({ root, input: priorInput, envelope: priorReturn });
    const priorResult = priorReturn.result || await readSkillSessionJson({ root, session_directory: session, path: last.result_ref });
    if (allowed[last.code]) {
      const signature = (result) => JSON.stringify([result.code, result.summary, result.artifacts.map(({ kind, sha256 }) => [kind, sha256])]);
      const matching = [];
      for (const attempt of last.attempts || []) {
        if (attempt.code !== last.code || !attempt.result_ref) continue;
        const result = await readSkillSessionJson({ root, session_directory: session, path: attempt.result_ref });
        if (signature(result) === signature(priorResult)) matching.push(attempt.execution_id);
      }
      if (matching.length >= 2) throw new Error('Revision repeated without changed evidence; inspect and report before retrying');
    }
    const planSetId = priorInput.context?.plan_set_id;
    input_refs.push(...priorResult.artifacts.filter((artifact) => !(stageId === 'to-ticket' && planSetId && artifact.base === 'workspace' && artifact.path?.startsWith(`docs/plans/${planSetId}/`))));
    producer_result_refs[lastStage] = { base: 'session', path: last.result_ref };
    transition = { from_stage: lastStage, code: last.code, result_ref: last.result_ref, summary: priorResult.summary };
  }
  const composer = state.stages?.['workflow-compose'];
  let worktree_ref;
  if (composer?.result_ref) {
    const result = await readSkillSessionJson({ root, session_directory: session, path: composer.result_ref });
    const preparedInput = await readExecutionInput({ root, execution_id: composer.execution_id });
    worktree_ref = preparedInput.context?.worktree_ref || result.worktree_ref;
  }
  if (worktreeRef && worktree_ref !== worktreeRef) throw new Error('Worktree reference does not match workflow');
  let taskSession = session;
  let executionWorkspace;
  let publicationDrafts;
  let plan_set_id;
  if (worktree_ref) {
    if (!worktree_ref.endsWith('/worktree.json')) throw new Error('Invalid canonical worktree reference');
    const directory = worktree_ref.slice(0, -'/worktree.json'.length);
    const record = parseWorktreeRecord(await readFile(worktree_ref, 'utf8'));
    if (record.session_directory !== directory) throw new Error('Canonical worktree record/session mismatch');
    if (await realpath(record.workspace) !== await realpath(root)) throw new Error('Stage workspace must be the prepared worktree');
    taskSession = await resolveSkillSession(root, record.session_directory);
    plan_set_id = record.plan_set_id;
    executionWorkspace = await resolveExecutionWorkspace(root, plan_set_id || null);
    workflowBinding = record.workflow_binding || null;
    if (workflowBinding) {
      if (orchestratorSession && workflowBinding.provider !== orchestratorSession.provider) throw new Error('Workflow binding provider must match the orchestrator provider');
      provider = workflowBinding.provider;
    }
    if (['to-ticket', 'plan-review', 'implement', 'implement-wrapper', 'sync-contracts'].includes(stage.skill) && !plan_set_id) throw new Error(`${stage.skill} requires plan_set_id in worktree.json`);
  }
  if (restart) {
    if (!worktree_ref || state.current_stage !== 'to-ticket' || !['waiting', 'failed'].includes(state.stages?.['to-ticket']?.status)) throw new Error('Restart requires a waiting or failed to-ticket stage in its active worktree');
    if (state.stages?.['spec-me']?.status !== 'completed' || state.stages?.['spec-me']?.code !== 'OK') throw new Error('Restart requires a completed spec-me stage');
    await assertExecutionStopped(state.stages['to-ticket'], { root, session: taskSession });
    if (state.stages?.['tracker-publish']?.execution_id) throw new Error('Cannot restart after tracker-publish has started');
    const historyPath = join(taskSession, `runtime/reviews/plan-${plan_set_id}.json`);
    try {
      const history = JSON.parse(await readFile(historyPath, 'utf8'));
      if (history.attempts?.at(-1)?.status === 'active') throw new Error('Cannot restart while a plan review is active');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const recovered = await existingRestartInput({ root, session: taskSession, planSetId: plan_set_id, previousExecutionId: state.stages['to-ticket'].execution_id, worktreeRef });
    if (recovered) return recovered;
  }
  let review_admission;
  if (stage.skill === 'spec-review') {
    if (!reviewAdmissionRef) throw new Error('Spec review requires an admitted snapshot');
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    review_admission = await validateSpecReviewAdmission({ root, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  } else if (stage.skill !== 'plan-review' && reviewAdmissionRef) throw new Error('Review admission applies only to Spec or plan review');
  for (const dependency of stage.needs) if (!['completed', 'skipped'].includes(state.stages?.[dependency]?.status)) throw new Error(`Dependency incomplete: ${dependency}`);
  if (stageId === 'implement-wrapper') {
    for (const producerStage of ['to-ticket', 'spec-me']) {
      const producer = state.stages?.[producerStage];
      if (producerStage === 'spec-me' && producer?.status !== 'completed') continue;
      if (producer?.status !== 'completed' || !producer.result_ref) throw new Error(`Completed ${producerStage} result is required for implementation`);
      const producerSession = await resolveSkillSession(root, producer.result_session_directory || session);
      const producerInput = await readExecutionInput({ root, execution_id: producer.execution_id });
      if (producerInput.workspace_root !== root) throw new Error('Planning workspace differs from implementation workspace');
      const envelope = await readSkillSessionJson({ root, session_directory: producerSession, path: `runtime/executions/${producer.execution_id}/return.json` });
      await validateSkillReturn({ root, input: producerInput, envelope });
      const result = envelope.result || await readSkillSessionJson({ root, session_directory: producerSession, path: producer.result_ref });
      if (producerSession !== taskSession && result.artifacts.some((artifact) => artifact.base === 'session')) throw new Error('Producer session artifact differs from the current worktree session');
      input_refs.push(...result.artifacts);
      producer_result_refs[producerStage] = { base: producerSession === taskSession ? 'session' : 'control_session', path: producer.result_ref };
    }
  }
  for (const reference of stage.inputs) {
    if (!reference.from_stage) {
      input_refs.push(reference.base === 'session' ? { ...reference, base: 'control_session' } : reference);
      continue;
    }
    const producer = state.stages?.[reference.from_stage];
    if (producer?.status !== 'completed' || !producer.result_ref) throw new Error(`Producer result unavailable: ${reference.from_stage}`);
    const producerSession = await resolveSkillSession(root, producer.result_session_directory || session);
    const producerInput = await readExecutionInput({ root, execution_id: producer.execution_id });
    const envelope = await readSkillSessionJson({ root, session_directory: producerSession, path: `runtime/executions/${producer.execution_id}/return.json` });
    await validateSkillReturn({ root: producerInput.workspace_root, input: producerInput, envelope });
    const result = await readSkillSessionJson({ root, session_directory: producerSession, path: producer.result_ref });
    producer_result_refs[reference.from_stage] = { base: producerSession === taskSession ? 'session' : 'control_session', path: producer.result_ref };
    const matches = result.artifacts.filter((artifact) => artifact.kind === reference.artifact);
    if (matches.length !== 1) throw new Error(`Producer must return one artifact with kind=${reference.artifact}`);
    if (matches[0].base === 'workspace' && producerInput.workspace_root !== root) throw new Error('Producer workspace differs; integrate artifact before dispatch');
    if (matches[0].base === 'session' && producerSession !== taskSession) throw new Error('Producer session artifact differs from the current worktree session');
    input_refs.push(matches[0]);
  }
  // A question a stage asked before an upstream stage (spec-me, to-ticket, tracker-publish) was completed again is
  // superseded by that revision: the stage starts over from the new plan instead of waiting for the old answer.
  const upstreamRevisedAfter = (entry) => ['spec-me', 'to-ticket', 'tracker-publish'].filter((id) => id !== stageId)
    .some((id) => Date.parse(state.stages?.[id]?.finished_at || 0) > Date.parse(entry?.updated_at || 0));
  const supersededQuestion = !restart && answer === null && feedback === null && state.stages?.[stageId]?.status === 'waiting'
    && state.stages[stageId].code === 'USER_DECISION_REQUIRED' && upstreamRevisedAfter(state.stages[stageId]);
  const previous = restart || supersededQuestion ? null : state.stages?.[stageId];
  // The user may also redirect a stage that is waiting on its own question: the instruction replaces that question,
  // and the stage resumes in the same conversation with it instead of an answer.
  const userRevisionWaiting = userRevision && previous?.result_ref && (previous.status === 'completed' && previous.code === 'OK' || previous.status === 'waiting' && previous.code === 'USER_DECISION_REQUIRED');
  if (userRevision && !userRevisionWaiting) throw new Error('User revision requires a completed stage or one waiting on its question');
  if (userRevision && Object.values(state.stages).some((item) => item?.status === 'running')) throw new Error('User revision cannot start while another stage is running');
  let conversation = {};
  let interruptedAnswers;
  const crossStageRevision = transition && lastStage !== stageId && REVISION_TARGETS[transition.code] === stageId;
  if (feedback !== null && crossStageRevision && !previous) {
    conversation = { previous_result_ref: transition.result_ref };
  } else if (feedback !== null) {
    if (!previous) throw new Error('Feedback requires a review, matching revision or blocked stage, or a confirmed interrupted stage');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (userRevision && stageId === 'implement-wrapper') {
      if (previous.status !== 'completed' || previous.code !== 'OK') throw new Error('E2E repair requires a completed implementation');
      if (previousInput.context?.plan_id !== planId) throw new Error('Implementation revision plan must match the completed stage');
      if (!/^runtime\/execution\/[A-Za-z0-9._-]+\/receipt\.json$/.test(repairReceipt)) throw new Error('Invalid E2E failure receipt reference');
      const receipt = await readSkillSessionJson({ root, session_directory: taskSession, path: repairReceipt });
      if (lastStage === 'e2e-test') {
        if (!last?.result_ref || !['failed', 'blocked', 'waiting'].includes(last.status)) throw new Error('E2E repair requires a validated failed stage result');
        const e2eInput = await readExecutionInput({ root, execution_id: last.execution_id });
        const e2eReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${last.execution_id}/return.json` });
        await validateSkillReturn({ root, input: e2eInput, envelope: e2eReturn });
        if (e2eReturn.result_ref !== last.result_ref || !e2eReturn.result?.artifacts?.some((item) => item.base === 'session' && item.path === repairReceipt && item.kind === 'e2e_receipt')) throw new Error('Repair receipt is not owned by the failed E2E stage');
        if (testDefectFailure && !e2eReturn.result.artifacts.some((item) => item.base === 'session' && item.path === testDefectFailure && item.kind === 'e2e_failure')) throw new Error('Test defect evidence is not owned by the failed E2E stage');
      }
      if (!['failed', 'blocked', 'interrupted'].includes(receipt.status) || !receipt.profile_id || !receipt.finished_at) throw new Error('E2E failure receipt is not a finished failure');
      if (!/^[a-f0-9]{64}$/.test(receipt.config_hashes?.['docs/agents/execution.json'] || '')) throw new Error('E2E failure receipt lacks profile evidence');
      const review = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/reviews/implementation-${planId}-evidence.json` });
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (review.review_input?.implementation_commit_sha !== head || (receipt.head && receipt.head !== head)) throw new Error('E2E failure target commit is stale');
      const plan = await readFile(join(root, 'docs/plans', plan_set_id, `${planId}.md`), 'utf8');
      if (!plan.includes(`\`${receipt.profile_id}\``)) throw new Error('E2E failure profile does not match the plan');
      const inputs = (await readFile(join(taskSession, 'runtime/orchestrator/user-inputs.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const orchestratorId = orchestratorSession?.session_id || codexSessionId;
      if (testDefectFailure) {
        if (!/^runtime\/e2e\/[A-Za-z0-9._-]+\/failure\.json$/.test(testDefectFailure)) throw new Error('Invalid test defect evidence reference');
        const failure = await readSkillSessionJson({ root, session_directory: taskSession, path: testDefectFailure });
        const copy = await readSkillSessionJson({ root, session_directory: taskSession, path: testDefectFailure.replace(/failure\.json$/, 'receipt.json') });
        if (receipt.status !== 'failed' || receipt.phase !== 'command' || failure.status !== 'failed' || failure.profile_id !== receipt.profile_id || failure.target_commit !== head || !Array.isArray(failure.failures) || !failure.failures.length || !isDeepStrictEqual(copy, receipt)) throw new Error('Test defect evidence does not match the failed E2E run');
      }
      if (!orchestratorId || !inputs.some((item) => item.text === approvalAnswer && item.session_id === orchestratorId && (testDefectFailure ? Date.parse(item.at) <= Date.parse(receipt.started_at) : Date.parse(item.at) > Date.parse(receipt.finished_at)))) throw new Error('E2E repair approval was not recorded for this failure');
      for (const [path, hash] of Object.entries(receipt.config_hashes || {})) {
        await assertWorkspaceTarget(root, path);
        if (createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== hash) throw new Error(`E2E failure receipt is stale: ${path}`);
      }
    }
    if (stageId === 'implement-wrapper' && planId === null) planId = previousInput.context?.plan_id ?? null;
    // A stage the user cancelled (for example to update Harness) resumes like a failed one: same conversation,
    // after checking that its processes are gone.
    let interrupted = ['failed', 'cancelled'].includes(previous?.status);
    if (interrupted) await assertExecutionStopped(previous, { root, session: taskSession });
    if (!interrupted && previous?.status === 'running' && !previous.result_ref) {
      await assertExecutionStopped(previous, { root, session: taskSession });
      interrupted = true;
    }
    const reviewWaiting = previous?.status === 'waiting' && previous.code === 'REVIEW_REQUIRED' && previous.result_ref;
    const revisionWaiting = previous?.status === 'waiting' && previous.result_ref && REVISION_TARGETS[previous.code] === stageId;
    if (!interrupted && !(reviewWaiting || revisionWaiting || userRevisionWaiting || crossStageRevision || (previous?.status === 'blocked' && previous.result_ref))) throw new Error('Feedback requires a failed, cancelled, review, matching revision, blocked, or confirmed interrupted stage');
    if (previousInput.skill !== stage.skill || previousInput.context?.stage_id !== stageId || previousInput.workspace_root !== root || previousInput.session_directory !== taskSession || previousInput.context?.worktree_ref !== worktreeRef) throw new Error('Feedback target does not match stage state');
    if (!interrupted) {
      const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
      if (previousSession !== taskSession) throw new Error('Feedback target belongs to a different worktree session');
      const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
      await validateSkillReturn({ root, input: previousInput, envelope: previousReturn, reopening: Boolean(userRevisionWaiting || (crossStageRevision && previous.status === 'completed' && previous.code === 'OK')) });
      if (previousReturn.result_ref !== previous.result_ref || previousReturn.code !== previous.code || ((reviewWaiting || revisionWaiting) && previousReturn.status !== 'action_required')) throw new Error('Feedback target does not match stage state');
    }
    const neverStarted = interrupted && previous.runner_managed && !previous.child && !previousInput.context?.resume_session_id;
    const sessionInfo = neverStarted ? null : await executionSession({ root, session: taskSession, executionId: previous.execution_id, worktreeRef });
    if (sessionInfo) provider = sessionInfo.provider;
    else if (previousInput.context?.provider) provider = previousInput.context.provider;
    if (interrupted) interruptedAnswers = join(taskSession, prefix, 'answers.json');
    const priorResult = crossStageRevision ? transition.result_ref : previous.result_ref || (interrupted ? previousInput.context?.previous_result_ref : null);
    conversation = { ...(userRevision ? { user_revision: true } : {}), ...(repairReceipt ? { e2e_failure_receipt: repairReceipt, e2e_repair_approval: approvalAnswer } : {}), ...(testDefectFailure ? { e2e_test_defect_failure: testDefectFailure } : {}), ...(priorResult ? { previous_result_ref: priorResult } : {}), ...(sessionInfo ? { resume_session_id: sessionInfo.session_id, resume_provider: sessionInfo.provider } : {}), ...(interrupted && stage.skill === 'spec-me' ? { interrupted_execution_id: previous.execution_id, ...(previousInput.context?.approved_spec_overwrites ? { approved_spec_overwrites: previousInput.context.approved_spec_overwrites } : {}) } : {}) };
  }
  if ((previous?.code === 'USER_DECISION_REQUIRED' && !userRevisionWaiting) || answer !== null) {
    if (answer === null) throw new Error('User answer required before resuming this stage');
    if (previous?.status !== 'waiting') throw new Error('Stage is not waiting for a response');
    const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
    if (previousSession !== taskSession) throw new Error('Pending decision belongs to a different worktree session');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (stageId === 'implement-wrapper' && planId === null) planId = previousInput.context?.plan_id ?? null;
    const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    await validateSkillReturn({ root, input: previousInput, envelope: previousReturn });
    if (previousReturn.status !== 'action_required' || previousReturn.code !== previous.code || previousReturn.result_ref !== previous.result_ref || previousInput.skill !== stage.skill) throw new Error('Pending response does not match stage state');
    const sessionInfo = await executionSession({ root, session: taskSession, executionId: previous.execution_id, worktreeRef });
    provider = sessionInfo.provider;
    const result = previousReturn.result || await readSkillSessionJson({ root, session_directory: previousSession, path: previous.result_ref });
    const batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer);
    if (!batchAnswers.complete) return { waiting_for_answers: true, questions: result.questions, answers: batchAnswers.answers };
    answer = batchAnswers.answers;
    conversation = { previous_result_ref: previous.result_ref, resume_session_id: sessionInfo.session_id, resume_provider: sessionInfo.provider, ...(previousInput.context?.approved_spec_overwrites ? { approved_spec_overwrites: previousInput.context.approved_spec_overwrites } : {}) };
  }
  if (workflowBinding && provider !== workflowBinding.provider) throw new Error('Workflow binding provider must match the resumed session');
  if (e2eRequest) {
    if (!/^runtime\/e2e\/requests\/[A-Za-z0-9._-]+\.json$/.test(e2eRequest)) throw new Error('Invalid E2E request reference');
    const request = await readSkillSessionJson({ root, session_directory: taskSession, path: e2eRequest });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (request.target_commit !== head || !Array.isArray(request.scenarios) || !request.scenarios.length || !request.scenarios.every((item) => typeof item === 'string' && item.trim()) || !request.approval_answer || !request.profile_id || !Number.isInteger(request.timeout_ms) || request.timeout_ms <= 0) throw new Error('E2E request target, scenarios, approval or timeout is invalid');
    const manifestText = await readFile(join(root, 'docs/agents/execution.json'));
    if (request.manifest_sha256 !== createHash('sha256').update(manifestText).digest('hex')) throw new Error('E2E request execution profile has changed');
    const manifest = JSON.parse(manifestText);
    const profile = manifest.profiles?.[request.profile_id];
    if (profile?.purpose !== 'e2e' || profile.timeout_ms !== request.timeout_ms) throw new Error('E2E request does not match the execution profile');
    const inputs = (await readFile(join(taskSession, 'runtime/orchestrator/user-inputs.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const orchestratorId = orchestratorSession?.session_id || codexSessionId;
    if (!orchestratorId || !inputs.some((item) => item.text === request.approval_answer && item.session_id === orchestratorId)) throw new Error('E2E request approval was not recorded');
    input_refs.push({ base: 'session', path: e2eRequest, kind: 'approved_e2e_request', sha256: createHash('sha256').update(await readFile(join(taskSession, e2eRequest))).digest('hex') });
  }
  let plan_review_admission;
  if (stage.skill === 'plan-review') {
    if (!reviewAdmissionRef) throw new Error('Plan review requires an admitted snapshot');
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    plan_review_admission = await validatePlanReviewAdmission({ root, planSetId: plan_set_id, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  }
  const execution_id = `${stage.id}-${randomUUID()}`;
  let approvedSpecOverwrites;
  if (specOverwriteApproved) {
    if (!plan_set_id) throw new Error('Spec overwrite approval requires a plan set');
    approvedSpecOverwrites = {};
    for (const axis of ['product', 'architecture']) {
      try {
        const path = `docs/specs/${plan_set_id}/${axis}-spec.md`;
        await assertWorkspaceTarget(root, path);
        const info = await lstat(join(root, path));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Spec approval requires a regular unshared file');
        approvedSpecOverwrites[axis] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (review_admission || plan_review_admission) input_refs.push({ base: 'control_session', path: reviewAdmissionRef });
  if (stage.skill === 'tracker-publish') publicationDrafts = await preparePublicationDrafts({ root, planSetId: plan_set_id });
  if (stageId === 'implement-wrapper' && !planId) throw new Error('implement-wrapper resume needs the assigned plan from its previous input');
  if (planId !== null) {
    if (!plan_set_id) throw new Error('--plan needs a worktree plan set');
    await readFile(join(root, 'docs/plans', plan_set_id, `${planId}.md`)).catch(() => { throw new Error(`Plan ${planId} is not part of plan set ${plan_set_id}`); });
  }
  const checkpointPath = stageId === 'implement-wrapper' && planId ? planRuntimePaths({ root, planId }).checkpoint_path : null;
  const input = { schema_version: 1, execution_id, skill: stage.skill, workspace_root: root, session_directory: taskSession, scope: stage.scope, input_refs, context: { ...(codexSessionId ? { codex_session_id: codexSessionId } : {}), ...(orchestratorSession ? { orchestrator_session_id: orchestratorSession.session_id, orchestrator_provider: orchestratorSession.provider } : {}), provider, ...(executionWorkspace ? { execution_workspace: executionWorkspace } : {}), ...(publicationDrafts ? { publication_drafts: publicationDrafts } : {}), ...(workflowBinding ? { workflow_binding: workflowBinding } : {}), stage_id: stage.id, control_session_directory: session, workflow_ref: workflowRef, ...conversation, ...(transition ? { transition } : {}), ...(Object.keys(producer_result_refs).length ? { producer_result_refs } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(planId ? { plan_id: planId } : {}), ...(plan_set_id ? { plan_set_id } : {}), ...(checkpointPath ? { checkpoint_path: checkpointPath } : {}), ...(publicationApproved ? { publication_approved: true } : {}), ...(review_admission ? { review_admission } : {}), ...(plan_review_admission ? { plan_review_admission } : {}), conditions: stage.conditions, gates: stage.gates, outputs: stage.outputs } };
  if (e2eRequest) input.context.agent_profile = 'e2e_test_runner';
  if (approvedSpecOverwrites) input.context.approved_spec_overwrites = approvedSpecOverwrites;
  input.input_refs = input.input_refs.filter((item, index, refs) => refs.findIndex((other) => item.base === other.base && item.path === other.path && item.kind === other.kind && item.sha256 === other.sha256) === index);
  await validateSkillInput({ root, input });
  const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
  if (restart) await archiveToTicket({ root, session: taskSession, planSetId: plan_set_id, previousExecutionId: state.stages['to-ticket'].execution_id, restartExecutionId: execution_id });
  const paths = stageExecutionPaths(root, execution_id);
  if (paths.session !== taskSession) throw new Error('Execution session does not match workspace');
  await mkdir(paths.directory, { recursive: true });
  if (Array.isArray(answer)) await writeFile(paths.files.answers, JSON.stringify(answer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (interruptedAnswers) await copyFile(interruptedAnswers, paths.files.answers).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (feedback !== null) await writeFile(paths.files.feedback, JSON.stringify({ feedback }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const storedInput = storedStageInput(input);
  return { input: storedInput, path, session_directory: taskSession, execution_directory: paths.directory, ...(answer !== null ? { answer } : {}) };
}
