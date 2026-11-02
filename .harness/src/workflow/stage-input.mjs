import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
import { mergeAnswers } from './questions.mjs';
import { writeExecutionInput } from './execution-input.mjs';
import { assertExecutionStopped, recordExecutionState } from './execution-state.mjs';

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
  let previous = [];
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(incoming)) throw new Error('Answers must be a JSON array');
  if (previous.length && incoming.every((entry) => previous.some((item) => item.question_id === entry.question_id && item.answer === entry.answer))) incoming = [];
  const merged = mergeAnswers(questions, previous, incoming);
  await writeFile(path, JSON.stringify(merged.answers, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

async function executionThreadId({ root, session, executionId, worktreeRef }) {
  let threadId;
  try { threadId = (await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${executionId}/exec.stderr.json` })).thread_id; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expectedThread = (await readExecutionInput({ root, execution_id: executionId })).context?.resume_session_id;
  if (threadId && expectedThread && threadId !== expectedThread) throw new Error('Recorded Codex session ID does not match resumed session');
  if (!threadId) threadId = expectedThread;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) {
    if (!worktreeRef) throw new Error('Codex session ID missing from execution log');
    const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
    const matches = Object.values(record.agent_sessions || {}).filter((entry) => entry.execution_id === executionId);
    if (matches.length !== 1) throw new Error('Codex session ID missing or ambiguous in canonical worktree record');
    threadId = matches[0].session_id;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Codex session ID missing from execution');
  return threadId;
}

export async function prepareStageInput({ root, session, worktreeRef = null, workflowRef, stageId, codexSessionId, answer = null, feedback = null, reviewAdmissionRef = null, publicationApproved = false }) {
  if (answer !== null && (typeof answer !== 'string' || !answer.trim())) throw new Error('User answer must not be empty');
  if (feedback !== null && (typeof feedback !== 'string' || !feedback.trim() || answer !== null || reviewAdmissionRef)) throw new Error('Invalid execution feedback');
  let state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.schema_version !== 1 || state.stages?.['workflow-compose']?.status !== 'completed') throw new Error('Worktree preparation is incomplete');
  if (stageId === 'tracker-publish' && (!publicationApproved || state.stages?.['to-ticket']?.status !== 'completed' || state.stages?.['to-ticket']?.code !== 'OK')) throw new Error('Completed to-ticket and user publication approval are required');
  if (publicationApproved && stageId !== 'tracker-publish') throw new Error('Publication approval is only valid for tracker-publish');
  const running = state.stages?.[stageId];
  if (running?.status === 'running' && running.result_ref === null) {
    let stopped = false;
    try { await assertExecutionStopped(running, { root, session }); stopped = true; }
    catch (error) { if (!/Stage already running/.test(error.message)) throw error; }
    if (stopped) {
      const prefix = `runtime/executions/${running.execution_id}`;
      let envelope, log;
      try {
        envelope = await readSkillSessionJson({ root, session_directory: session, path: `${prefix}/return.json` });
        log = await readSkillSessionJson({ root, session_directory: session, path: `${prefix}/exec.stderr.json` });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (envelope && log?.exit_code === 0 && envelope.result_ref === `${prefix}/result.json`) {
        const previousInput = await readExecutionInput({ root, execution_id: running.execution_id });
        const result = await readSkillSessionJson({ root, session_directory: session, path: envelope.result_ref });
        if (JSON.stringify(result) !== JSON.stringify(envelope.result)) throw new Error('Stored execution result does not match return');
        await validateSkillReturn({ root, input: previousInput, envelope });
        await recordExecutionState({ root, input: previousInput, binding: log.binding || { model: running.model, reasoning_effort: running.reasoning_effort }, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref });
        state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
      }
    }
  }
  const prepared = await readExecutionInput({ root, execution_id: state.stages['workflow-compose'].execution_id });
  const stage = { id: stageId, skill: stageId, scope: prepared.scope, needs: [], inputs: [], outputs: [], conditions: [], gates: [] };
  const input_refs = [];
  const producer_result_refs = {};
  const lastStage = state.current_stage;
  const last = lastStage && lastStage !== 'workflow-compose' ? state.stages?.[lastStage] : null;
  if (last?.code === 'SUBTASK_REQUIRED') throw new Error('Legacy SUBTASK_REQUIRED execution cannot be resumed: the pending subagent identity and result are not recorded; in-place recovery is unsupported. Preserve the session artifacts and report this limitation.');
  let transition;
  if (last && (lastStage !== stageId || ['SPEC_REVISION_REQUIRED', 'PLAN_REVISION_REQUIRED', 'IMPLEMENTATION_REVISION_REQUIRED'].includes(last.code))) {
    if (!last.result_ref || !['completed', 'waiting'].includes(last.status)) throw new Error('Previous stage has no usable result');
    const allowed = { SPEC_REVISION_REQUIRED: 'spec-me', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' };
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
    input_refs.push(...priorResult.artifacts);
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
  let plan_set_id;
  if (worktree_ref) {
    if (!worktree_ref.endsWith('/worktree.json')) throw new Error('Invalid canonical worktree reference');
    const directory = worktree_ref.slice(0, -'/worktree.json'.length);
    const record = parseWorktreeRecord(await readFile(worktree_ref, 'utf8'));
    if (record.session_directory !== directory) throw new Error('Canonical worktree record/session mismatch');
    if (await realpath(record.workspace) !== await realpath(root)) throw new Error('Stage workspace must be the prepared worktree');
    taskSession = await resolveSkillSession(root, record.session_directory);
    plan_set_id = record.plan_set_id;
    if (['to-ticket', 'plan-review', 'implement', 'implement-wrapper'].includes(stage.skill) && !plan_set_id) throw new Error(`${stage.skill} requires plan_set_id in worktree.json`);
  }
  let review_admission;
  if (stage.skill === 'spec-review') {
    if (!reviewAdmissionRef) throw new Error('Spec review requires an admitted snapshot');
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    review_admission = await validateSpecReviewAdmission({ root, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  } else if (stage.skill !== 'plan-review' && reviewAdmissionRef) throw new Error('Review admission applies only to Spec or plan review');
  for (const dependency of stage.needs) if (!['completed', 'skipped'].includes(state.stages?.[dependency]?.status)) throw new Error(`Dependency incomplete: ${dependency}`);
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
  const previous = state.stages?.[stageId];
  let conversation = {};
  let interruptedAnswers;
  if (feedback !== null) {
    let interrupted = previous?.status === 'failed' && previous.code === 'EXECUTION_ERROR' && previous.reason === 'Execution interrupted after its processes exited' && previous.result_ref === null;
    if (!interrupted && previous?.status === 'running' && previous.result_ref === null) {
      await assertExecutionStopped(previous, { root, session: taskSession });
      interrupted = true;
    }
    const reviewWaiting = previous?.status === 'waiting' && previous.code === 'REVIEW_REQUIRED' && previous.result_ref;
    if (!interrupted && !(reviewWaiting || (previous?.status === 'blocked' && previous.result_ref))) throw new Error('Feedback requires a REVIEW_REQUIRED or blocked stage, or a confirmed interrupted stage');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (previousInput.skill !== stage.skill || previousInput.context?.stage_id !== stageId || previousInput.workspace_root !== root || previousInput.session_directory !== taskSession || previousInput.context?.worktree_ref !== worktreeRef) throw new Error('Feedback target does not match stage state');
    if (!interrupted) {
      const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
      if (previousSession !== taskSession) throw new Error('Feedback target belongs to a different worktree session');
      const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
      await validateSkillReturn({ root, input: previousInput, envelope: previousReturn });
      if (previousReturn.result_ref !== previous.result_ref || previousReturn.code !== previous.code || (reviewWaiting && previousReturn.status !== 'action_required')) throw new Error('Feedback target does not match stage state');
    }
    const neverStarted = interrupted && previous.runner_managed && !previous.child && !previousInput.context?.resume_session_id;
    const threadId = neverStarted ? null : await executionThreadId({ root, session: taskSession, executionId: previous.execution_id, worktreeRef });
    if (interrupted) interruptedAnswers = join(taskSession, prefix, 'answers.json');
    const priorResult = previous.result_ref || (interrupted ? previousInput.context?.previous_result_ref : null);
    conversation = { ...(priorResult ? { previous_result_ref: priorResult } : {}), ...(threadId ? { resume_session_id: threadId } : {}) };
  }
  if (previous?.code === 'USER_DECISION_REQUIRED' || answer !== null) {
    if (answer === null) throw new Error('User answer required before resuming this stage');
    if (previous?.status !== 'waiting') throw new Error('Stage is not waiting for a response');
    const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
    if (previousSession !== taskSession) throw new Error('Pending decision belongs to a different worktree session');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    await validateSkillReturn({ root, input: previousInput, envelope: previousReturn });
    if (previousReturn.status !== 'action_required' || previousReturn.code !== previous.code || previousReturn.result_ref !== previous.result_ref || previousInput.skill !== stage.skill) throw new Error('Pending response does not match stage state');
    const log = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/exec.stderr.json` });
    const threadId = log.thread_id || /(?:^|\n)session id:\s*([0-9a-f-]{36})(?:\n|$)/i.exec(log.stderr || '')?.[1];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Codex session ID missing from stage execution');
    const result = previousReturn.result || await readSkillSessionJson({ root, session_directory: previousSession, path: previous.result_ref });
    const batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer);
    if (!batchAnswers.complete) return { waiting_for_answers: true, questions: result.questions, answers: batchAnswers.answers };
    answer = batchAnswers.answers;
    conversation = { previous_result_ref: previous.result_ref, resume_session_id: threadId };
  }
  let plan_review_admission;
  if (stage.skill === 'plan-review') {
    if (!reviewAdmissionRef) throw new Error('Plan review requires an admitted snapshot');
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    plan_review_admission = await validatePlanReviewAdmission({ root, planSetId: plan_set_id, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  }
  const execution_id = `${stage.id}-${randomUUID()}`;
  if (review_admission || plan_review_admission) input_refs.push({ base: 'control_session', path: reviewAdmissionRef });
  const input = { schema_version: 1, execution_id, skill: stage.skill, workspace_root: root, session_directory: taskSession, scope: stage.scope, input_refs, context: { ...(codexSessionId ? { codex_session_id: codexSessionId } : {}), stage_id: stage.id, control_session_directory: session, workflow_ref: workflowRef, ...conversation, ...(transition ? { transition } : {}), ...(Object.keys(producer_result_refs).length ? { producer_result_refs } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(plan_set_id ? { plan_set_id } : {}), ...(publicationApproved ? { publication_approved: true } : {}), ...(review_admission ? { review_admission } : {}), ...(plan_review_admission ? { plan_review_admission } : {}), conditions: stage.conditions, gates: stage.gates, outputs: stage.outputs } };
  input.input_refs = input.input_refs.filter((item, index, refs) => refs.findIndex((other) => item.base === other.base && item.path === other.path && item.kind === other.kind && item.sha256 === other.sha256) === index);
  await validateSkillInput({ root, input });
  const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
  await mkdir(join(taskSession, 'runtime/executions', execution_id), { recursive: true });
  if (Array.isArray(answer)) await writeFile(join(taskSession, 'runtime/executions', execution_id, 'answers.json'), JSON.stringify(answer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (interruptedAnswers) await copyFile(interruptedAnswers, join(taskSession, 'runtime/executions', execution_id, 'answers.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (feedback !== null) await writeFile(join(taskSession, 'runtime/executions', execution_id, 'feedback.json'), JSON.stringify({ feedback }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const storedInput = storedStageInput(input);
  return { input: storedInput, path, session_directory: taskSession, ...(answer !== null ? { answer } : {}) };
}
