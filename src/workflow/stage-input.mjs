import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateComposedWorkflow, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
import { mergeAnswers } from './questions.mjs';
import { writeExecutionInput } from './execution-input.mjs';

function storedStageInput(input) {
  if (!input.context?.worktree_ref || !['spec-me', 'to-ticket'].includes(input.skill)) return input;
  const { workspace_root, shared_guidance_root, session_directory, ...rest } = input;
  const { plan_set_id, ...context } = rest.context;
  return { ...rest, context };
}

async function collectAnswers(session, prefix, questions, answer) {
  let incoming;
  try { incoming = JSON.parse(answer); } catch { throw new Error('Answers must be a JSON array'); }
  const path = join(session, prefix, 'answers.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const merged = mergeAnswers(questions, previous, incoming);
  await writeFile(path, JSON.stringify(merged.answers, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export async function prepareStageInput({ root, session, worktreeRef = null, workflowRef, stageId, codexSessionId, answer = null, reviewAdmissionRef = null, subtask = null, subtaskResult = null, resumeSubtask = null, reviewSubtask = null, reviewResult = null, reviewDetails = false }) {
  if (answer !== null && (typeof answer !== 'string' || !answer.trim())) throw new Error('User answer must not be empty');
  const workflow = await readSkillSessionJson({ root, session_directory: session, path: workflowRef });
  await validateComposedWorkflow({ root, session_directory: session, workflow });
  const state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.schema_version !== 1 || state.workflow_ref !== workflowRef) throw new Error('Workflow state/reference mismatch');
  const stage = workflow.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error(`Unknown workflow stage: ${stageId}`);
  const input_refs = [];
  const producer_result_refs = {};
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
  if (reviewSubtask !== null) {
    if (previous?.code !== 'SUBTASK_REQUIRED' || answer !== null || subtask !== null || subtaskResult !== null || resumeSubtask !== null || reviewAdmissionRef || reviewDetails) throw new Error('Review requires a pending subtask');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(reviewSubtask)) throw new Error('Invalid review target execution ID');
    const targetState = state.stages?.[reviewSubtask];
    const prefix = `runtime/executions/${reviewSubtask}`;
    const targetInput = await readExecutionInput({ root, execution_id: reviewSubtask });
    const targetReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    if (targetState?.status !== 'waiting' || targetState.code !== 'REVIEW_REQUIRED' || targetState.result_session_directory !== taskSession || targetState.result_ref !== targetReturn.result_ref || targetInput.context?.parent_stage_id !== stageId || targetInput.context?.parent_execution_id !== previous.execution_id || targetInput.workspace_root !== root || targetInput.session_directory !== taskSession) throw new Error('Review target does not belong to the pending stage');
    await validateSkillReturn({ root, input: targetInput, envelope: targetReturn });
    const targetResult = targetReturn.result || await readSkillSessionJson({ root, session_directory: taskSession, path: targetReturn.result_ref });
    const request = targetResult.review_request;
    if (request?.context_path) request.context = await readSkillSessionJson({ root, session_directory: taskSession, path: request.context_path });
    if (!request || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.skill || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.role || '') || typeof request.purpose !== 'string' || !request.purpose.trim() || !request.context || typeof request.context !== 'object' || Array.isArray(request.context)) throw new Error('Structured review request with skill, role, purpose and context is required');
    const execution_id = `subtask-${randomUUID()}`;
    let input;
    if (reviewResult === null) {
      let reviewGate, reviewChecklist;
      if (request.skill === 'architecture-review') {
        const { loadNamedWorkflow } = await import('./loader.mjs');
        const { evaluateWorkflowStage } = await import('./stage-gates.mjs');
        const details = request.context.review_context || request.context;
        const ids = details.decision_ids || (details.decision_id ? [details.decision_id] : []);
        if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('Architecture review requires decision IDs');
        reviewChecklist = { decision_ids: ids };
        reviewGate = evaluateWorkflowStage({ workflow: await loadNamedWorkflow('spec-me', { root }), stageId: 'review-architecture-decisions', input: { review_session: details.review_session, mode: details.review_mode } });
        if (reviewGate.action !== 'dispatch') throw new Error('Architecture review is skipped by the selected review mode');
      }
      input = { schema_version: 1, execution_id, skill: request.skill, workspace_root: root, shared_guidance_root: targetInput.shared_guidance_root, session_directory: taskSession, scope: request.purpose, input_refs: targetResult.artifacts, context: { codex_session_id: codexSessionId, stage_id: execution_id, control_session_directory: session, workflow_ref: workflowRef, parent_stage_id: stageId, parent_execution_id: previous.execution_id, reviewed_execution_id: reviewSubtask, role: request.role, review_context_ref: request.context_path, target_result_ref: targetReturn.result_ref, ...(reviewGate ? { review_gate: reviewGate, review_checklist: reviewChecklist } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(plan_set_id ? { plan_set_id } : {}), outputs: [] } };
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(reviewResult)) throw new Error('Invalid reviewer execution ID');
      const reviewerPrefix = `runtime/executions/${reviewResult}`;
      const reviewerInput = await readExecutionInput({ root, execution_id: reviewResult });
      const reviewerReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${reviewerPrefix}/return.json` });
      const reviewerState = state.stages?.[reviewResult];
      if (reviewerInput.context?.reviewed_execution_id !== reviewSubtask || reviewerInput.context?.parent_stage_id !== stageId || reviewerInput.context?.parent_execution_id !== previous.execution_id || reviewerInput.skill !== request.skill || reviewerInput.context?.role !== request.role || reviewerInput.workspace_root !== root || reviewerInput.session_directory !== taskSession || reviewerState?.result_ref !== reviewerReturn.result_ref || reviewerState?.code !== reviewerReturn.code || reviewerState?.result_session_directory !== taskSession || !['completed', 'waiting'].includes(reviewerState?.status)) throw new Error('Reviewer result does not match the pending review');
      await validateSkillReturn({ root, input: reviewerInput, envelope: reviewerReturn });
      const reviewerResult = reviewerReturn.result || await readSkillSessionJson({ root, session_directory: taskSession, path: reviewerReturn.result_ref });
      if (!(reviewerReturn.status === 'completed' && reviewerReturn.code === 'OK') && !(reviewerReturn.status === 'action_required' && reviewerResult.artifacts.length > 0)) throw new Error('Reviewer has not returned a usable review');
      const log = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/exec.stderr.json` });
      const threadId = log.thread_id || /(?:^|\n)session id:\s*([0-9a-f-]{36})(?:\n|$)/i.exec(log.stderr || '')?.[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Codex session ID missing from review target');
      const { answer_ref, question_ref, ...context } = targetInput.context;
      input = { ...targetInput, execution_id, input_refs: [...targetInput.input_refs, ...reviewerResult.artifacts], context: { ...context, codex_session_id: codexSessionId, stage_id: execution_id, resume_session_id: threadId, previous_result_ref: targetReturn.result_ref, review_result_ref: reviewerReturn.result_ref } };
    }
    await validateSkillInput({ root, input });
    const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
    await mkdir(join(taskSession, 'runtime/executions', execution_id), { recursive: true });
    const storedInput = storedStageInput(input);
    return { input: storedInput, path, session_directory: taskSession };
  }
  if (reviewResult !== null) throw new Error('Reviewer result requires a pending review target');
  if (resumeSubtask !== null) {
    if (previous?.code !== 'SUBTASK_REQUIRED' || (answer === null && !reviewDetails) || (answer !== null && reviewDetails) || subtask !== null || subtaskResult !== null || reviewAdmissionRef) throw new Error('Subtask resume requires an answer or review detail request');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resumeSubtask)) throw new Error('Invalid subtask execution ID');
    const childState = state.stages?.[resumeSubtask];
    if (childState?.status !== 'waiting' || (reviewDetails && childState.code !== 'REVIEW_REQUIRED') || childState.result_session_directory !== taskSession) throw new Error('Subtask is not waiting for the requested continuation');
    const prefix = `runtime/executions/${resumeSubtask}`;
    const childInput = await readExecutionInput({ root, execution_id: resumeSubtask });
    const envelope = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
    if (childInput.context?.parent_stage_id !== stageId || childInput.context?.parent_execution_id !== previous.execution_id || childInput.workspace_root !== root || childInput.session_directory !== taskSession || childState.result_ref !== envelope.result_ref || childState.code !== envelope.code || envelope.status !== 'action_required') throw new Error('Pending continuation does not belong to this parent stage');
    await validateSkillReturn({ root, input: childInput, envelope });
    const result = envelope.result || await readSkillSessionJson({ root, session_directory: taskSession, path: envelope.result_ref });
    let batchAnswers;
    if (!reviewDetails && result.questions?.length) {
      batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer);
      if (!batchAnswers.complete) return { waiting_for_answers: true, questions: result.questions, answers: batchAnswers.answers };
    }
    let questionRef, question;
    if (!reviewDetails) {
      questionRef = result.artifacts.find((item) => item.kind === 'user_question');
      if (questionRef) {
        if (questionRef.base !== 'session') throw new Error('Subtask question artifact must be in the task session');
      }
      question = result.question || (questionRef ? await readSkillSessionJson({ root, session_directory: taskSession, path: questionRef.path }) : null);
    }
    const log = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/exec.stderr.json` });
    const threadId = log.thread_id || /(?:^|\n)session id:\s*([0-9a-f-]{36})(?:\n|$)/i.exec(log.stderr || '')?.[1];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Codex session ID missing from subtask execution');
    const execution_id = `subtask-${randomUUID()}`;
    const { answer_ref, question_ref, ...priorContext } = childInput.context;
    const input = { ...childInput, execution_id, input_refs: [...childInput.input_refs, ...(reviewDetails ? result.artifacts : [])], context: { ...priorContext, codex_session_id: codexSessionId, stage_id: execution_id, resume_session_id: threadId, previous_result_ref: envelope.result_ref, ...(reviewDetails ? { review_details_requested: true } : question ? { ...(questionRef ? { question_ref: questionRef.path } : {}), question_id: question.question_id } : {}) } };
    await validateSkillInput({ root, input });
    const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
    await mkdir(join(taskSession, 'runtime/executions', execution_id), { recursive: true });
    const storedInput = storedStageInput(input);
    return { input: storedInput, path, session_directory: taskSession, ...(!reviewDetails ? { answer: batchAnswers ? batchAnswers.answers : { ...(question ? { question_id: question.question_id } : {}), answer } } : {}) };
  }
  if (reviewDetails) throw new Error('Review detail request requires a subtask to resume');
  const parentExecutions = new Set([...(previous?.attempts || []), previous].filter(Boolean).map((item) => item.execution_id));
  const completedSubtasks = [];
  for (const attempt of [...(previous?.attempts || []), previous].filter((item) => item?.execution_id)) {
    if (await resolveSkillSession(root, attempt.result_session_directory || session) !== taskSession) continue;
    const previousInput = await readExecutionInput({ root, execution_id: attempt.execution_id });
    const childExecutionId = previousInput.context?.subtask_result_execution_id || /^runtime\/executions\/([A-Za-z0-9_-]+)\/result\.json$/.exec(previousInput.context?.subtask_result_ref || '')?.[1];
    if (!childExecutionId || completedSubtasks.some((item) => item.execution_id === childExecutionId)) continue;
    const childState = state.stages?.[childExecutionId];
    if (childState?.status !== 'completed' || childState.result_session_directory !== taskSession) throw new Error('Completed subtask state is missing or mismatched');
    const childInput = await readExecutionInput({ root, execution_id: childExecutionId });
    const childReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${childExecutionId}/return.json` });
    if (childInput.context?.parent_stage_id !== stageId || !parentExecutions.has(childInput.context.parent_execution_id) || childInput.workspace_root !== root || childInput.session_directory !== taskSession || childReturn.status !== 'completed' || childState.result_ref !== childReturn.result_ref) throw new Error('Completed subtask does not belong to this stage');
    await validateSkillReturn({ root, input: childInput, envelope: childReturn });
    const result = childReturn.result || await readSkillSessionJson({ root, session_directory: taskSession, path: childReturn.result_ref });
    completedSubtasks.push({ execution_id: childExecutionId, skill: childInput.skill, scope: childInput.scope, result_ref: childReturn.result_ref });
    input_refs.push(...result.artifacts);
  }
  let conversation = {};
  let dispatched = null;
  if (subtask !== null || subtaskResult !== null || (previous?.code === 'SUBTASK_REQUIRED' && answer === null)) {
    if (answer !== null) throw new Error('Choose a subtask or answer the waiting execution, not both');
    if (previous?.code !== 'SUBTASK_REQUIRED' || !previous.result_ref) throw new Error('Stage has no pending subtask');
    if ((subtask === null) === (subtaskResult === null)) throw new Error('Select a pending subtask or supply its completed execution');
    const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
    if (previousSession !== taskSession) throw new Error('Pending subtask belongs to a different worktree session');
    const parentInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    const parentReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${previous.execution_id}/return.json` });
    await validateSkillReturn({ root, input: parentInput, envelope: parentReturn });
    if (parentReturn.code !== 'SUBTASK_REQUIRED' || parentReturn.result_ref !== previous.result_ref) throw new Error('Pending subtask request does not match stage state');
    const parentResult = parentReturn.result || await readSkillSessionJson({ root, session_directory: taskSession, path: previous.result_ref });
    const requests = parentResult.required_subtasks;
    if (!Array.isArray(requests)) throw new Error('Pending subtask requests missing');
    conversation = { previous_result_ref: previous.result_ref, parent_stage_result_ref: parentReturn.result_ref };
    if (subtask !== null) {
      if (!/^(0|[1-9][0-9]*)$/.test(subtask)) throw new Error('Subtask must be a zero-based index');
      const request = requests[Number(subtask)];
      if (!request || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.skill || '') || typeof request.purpose !== 'string' || !request.purpose.trim()) throw new Error('Invalid subtask request');
      dispatched = { request, index: Number(subtask) };
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subtaskResult)) throw new Error('Invalid subtask execution ID');
      const prefix = `runtime/executions/${subtaskResult}`;
      const childInput = await readExecutionInput({ root, execution_id: subtaskResult });
      const envelope = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
      const reused = childInput.context?.parent_execution_id !== previous.execution_id;
      if ((reused && !completedSubtasks.some((item) => item.execution_id === subtaskResult)) || childInput.context?.parent_stage_id !== stageId || childInput.workspace_root !== root || childInput.session_directory !== taskSession) throw new Error('Subtask does not belong to the pending stage');
      const request = reused ? requests.find((item) => item.skill === childInput.skill && (item.role === 'default' ? null : item.role || null) === (childInput.context.role || null)) : requests[childInput.context.subtask_index];
      if (!request || request.skill !== childInput.skill || (request.role === 'default' ? null : request.role || null) !== (childInput.context.role || null)) throw new Error('Subtask does not match the pending request');
      await validateSkillReturn({ root, input: childInput, envelope });
      if (envelope.status !== 'completed' || envelope.code !== 'OK') throw new Error('Subtask has not completed successfully');
      const childState = state.stages?.[subtaskResult];
      if (childState?.status !== 'completed' || childState.execution_id !== subtaskResult || childState.result_ref !== envelope.result_ref || childState.result_session_directory !== taskSession) throw new Error('Completed subtask state is missing or mismatched');
      const childResult = envelope.result || await readSkillSessionJson({ root, session_directory: taskSession, path: envelope.result_ref });
      input_refs.push(...childResult.artifacts);
      conversation = { previous_result_ref: previous.result_ref, parent_stage_result_ref: parentReturn.result_ref, subtask_result_ref: envelope.result_ref, subtask_result_execution_id: subtaskResult, subtask_index: requests.indexOf(request), ...(reused ? { subtask_reused: true } : {}) };
    }
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
    if (result.questions?.length) {
      const batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer);
      if (!batchAnswers.complete) return { waiting_for_answers: true, questions: result.questions, answers: batchAnswers.answers };
      answer = batchAnswers.answers;
    }
    const questionRef = result.artifacts.find((item) => item.kind === 'user_question');
    if (questionRef && questionRef.base !== 'session') throw new Error('Previous question artifact must be in the task session');
    const question = result.question || (questionRef ? await readSkillSessionJson({ root, session_directory: previousSession, path: questionRef.path }) : null);
    conversation = { previous_result_ref: previous.result_ref, ...(question ? { ...(questionRef ? { question_ref: questionRef.path } : {}), question_id: question.question_id } : {}), resume_session_id: threadId };
  }
  let shared = root;
  const { sessionDirectory } = await import('./session-output.mjs');
  try {
    const record = await readSkillSessionJson({ root, session_directory: sessionDirectory(root, { create: false }), path: 'worktree.json' });
    shared = record.return_root;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let plan_review_admission;
  if (stage.skill === 'plan-review') {
    if (!reviewAdmissionRef) throw new Error('Plan review requires an admitted snapshot');
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    plan_review_admission = await validatePlanReviewAdmission({ root, planSetId: plan_set_id, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  }
  const execution_id = `${dispatched ? 'subtask' : stage.id}-${randomUUID()}`;
  if (review_admission || plan_review_admission) input_refs.push({ base: 'control_session', path: reviewAdmissionRef });
  const input = { schema_version: 1, execution_id, skill: dispatched ? dispatched.request.skill : stage.skill, workspace_root: root, shared_guidance_root: shared, session_directory: taskSession, scope: dispatched ? dispatched.request.purpose : stage.scope, input_refs, context: { codex_session_id: codexSessionId, stage_id: dispatched ? execution_id : stage.id, control_session_directory: session, ...(dispatched ? { parent_stage_id: stage.id, parent_execution_id: previous.execution_id, subtask_index: dispatched.index, ...(dispatched.request.role && dispatched.request.role !== 'default' ? { role: dispatched.request.role } : {}) } : stage.role === 'default' ? {} : { role: stage.role }), workflow_ref: workflowRef, ...conversation, ...(Object.keys(producer_result_refs).length ? { producer_result_refs } : {}), ...(completedSubtasks.length ? { completed_subtasks: completedSubtasks } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(plan_set_id ? { plan_set_id } : {}), ...(review_admission ? { review_admission } : {}), ...(plan_review_admission ? { plan_review_admission } : {}), conditions: dispatched ? [] : stage.conditions, gates: dispatched ? [] : stage.gates, outputs: dispatched ? [] : stage.outputs } };
  await validateSkillInput({ root, input });
  const path = await writeExecutionInput(root, storedStageInput(input), plan_set_id);
  await mkdir(join(taskSession, 'runtime/executions', execution_id), { recursive: true });
  const storedInput = storedStageInput(input);
  return { input: storedInput, path, session_directory: taskSession, ...(answer !== null ? { answer: Array.isArray(answer) ? answer : { ...(conversation.question_id ? { question_id: conversation.question_id } : {}), answer } } : {}) };
}
