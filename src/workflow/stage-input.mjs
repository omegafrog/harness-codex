import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSkillSessionJson, validateComposedWorkflow, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';

export async function prepareStageInput({ root, session, workflowRef, stageId, codexSessionId, answerRef = null, reviewAdmissionRef = null }) {
  const workflow = await readSkillSessionJson({ root, session_directory: session, path: workflowRef });
  await validateComposedWorkflow({ root, session_directory: session, workflow });
  const state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (!codexSessionId || state.codex_session_id !== codexSessionId || state.workflow_ref !== workflowRef) throw new Error('Workflow state ownership/reference mismatch');
  const stage = workflow.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error(`Unknown workflow stage: ${stageId}`);
  let review_admission;
  if (stage.skill === 'spec-review') {
    if (!reviewAdmissionRef) throw new Error('Spec review requires an admitted snapshot');
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    review_admission = await validateSpecReviewAdmission({ root, admission: await readSkillSessionJson({ root, session_directory: session, path: reviewAdmissionRef }) });
  } else if (reviewAdmissionRef) throw new Error('Review admission applies only to Spec review');
  for (const dependency of stage.needs) if (!['completed', 'skipped'].includes(state.stages?.[dependency]?.status)) throw new Error(`Dependency incomplete: ${dependency}`);
  const input_refs = [];
  for (const reference of stage.inputs) {
    if (!reference.from_stage) { input_refs.push(reference); continue; }
    const producer = state.stages?.[reference.from_stage];
    if (producer?.status !== 'completed' || producer.result_session_directory !== session || !producer.result_ref) throw new Error(`Producer result unavailable: ${reference.from_stage}`);
    const producerInput = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${producer.execution_id}/input.json` });
    const envelope = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${producer.execution_id}/return.json` });
    await validateSkillReturn({ root: producerInput.workspace_root, input: producerInput, envelope });
    const result = await readSkillSessionJson({ root, session_directory: session, path: producer.result_ref });
    const matches = result.artifacts.filter((artifact) => artifact.kind === reference.artifact);
    if (matches.length !== 1) throw new Error(`Producer must return one artifact with kind=${reference.artifact}`);
    if (matches[0].base === 'workspace' && producerInput.workspace_root !== root) throw new Error('Producer workspace differs; integrate artifact before dispatch');
    input_refs.push(matches[0]);
  }
  const previous = state.stages?.[stageId];
  let conversation = {};
  if (previous?.code === 'USER_DECISION_REQUIRED') {
    if (!answerRef) throw new Error('User answer required before resuming this stage');
    const result = await readSkillSessionJson({ root, session_directory: session, path: previous.result_ref });
    const questionRef = result.artifacts.find((item) => item.kind === 'user_question');
    if (!questionRef || questionRef.base !== 'session') throw new Error('Previous question artifact missing');
    const question = await readSkillSessionJson({ root, session_directory: session, path: questionRef.path });
    const answer = await readSkillSessionJson({ root, session_directory: session, path: answerRef });
    if (answer.question_id !== question.question_id || typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('Answer does not match pending question');
    input_refs.push({ base: 'session', path: previous.result_ref }, questionRef, { base: 'session', path: answerRef });
    conversation = { previous_result_ref: previous.result_ref, question_ref: questionRef.path, answer_ref: answerRef };
  } else if (answerRef) throw new Error('Stage has no pending question');
  const composer = state.stages?.['workflow-compose'];
  let worktree_ref;
  if (composer?.result_ref) {
    const result = await readSkillSessionJson({ root, session_directory: session, path: composer.result_ref });
    const preparedInput = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${composer.execution_id}/input.json` });
    worktree_ref = preparedInput.context?.worktree_ref || result.details?.worktree_ref;
    input_refs.push({ base: 'session', path: composer.result_ref });
  }
  let shared = root;
  const { sessionDirectory } = await import('./session-output.mjs');
  try {
    const record = await readSkillSessionJson({ root, session_directory: sessionDirectory(root, { create: false }), path: 'worktree.json' });
    shared = record.return_root;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const execution_id = `${stage.id}-${randomUUID()}`;
  if (review_admission) input_refs.push({ base: 'session', path: reviewAdmissionRef });
  const input = { schema_version: 1, execution_id, skill: stage.skill, workspace_root: root, shared_guidance_root: shared, session_directory: session, scope: stage.scope, input_refs, context: { codex_session_id: codexSessionId, stage_id: stage.id, ...(stage.role === 'default' ? {} : { role: stage.role }), workflow_ref: workflowRef, ...conversation, ...(worktree_ref ? { worktree_ref } : {}), ...(review_admission ? { review_admission } : {}), conditions: stage.conditions, gates: stage.gates, outputs: stage.outputs } };
  await validateSkillInput({ root, input });
  const path = `runtime/executions/${execution_id}/input.json`;
  await mkdir(join(session, 'runtime/executions', execution_id), { recursive: true });
  await writeFile(join(session, path), JSON.stringify(input, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { input, path };
}
