import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
import { mergeAnswers } from './questions.mjs';
import { writeExecutionInput } from './execution-input.mjs';
import { assertExecutionStopped, processIdentity, recordExecutionState } from './execution-state.mjs';
import { parseYaml } from '../eval/yaml.mjs';
import { configuredProvider } from './providers/index.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

const REVISION_TARGETS = { SPEC_REVISION_REQUIRED: 'spec-me', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' };

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

export async function prepareStageInput({ root, session, worktreeRef = null, workflowRef, stageId, codexSessionId, orchestratorSession = null, answer = null, feedback = null, reviewAdmissionRef = null, publicationApproved = false, specOverwriteApproved = false }) {
  if (answer !== null && (typeof answer !== 'string' || !answer.trim())) throw new Error('User answer must not be empty');
  if (feedback !== null && (typeof feedback !== 'string' || !feedback.trim() || answer !== null || reviewAdmissionRef)) throw new Error('Invalid execution feedback');
  let provider = configuredProvider(parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')));
  let workflowBinding = null;
  let state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.schema_version !== 1 || state.stages?.['workflow-compose']?.status !== 'completed') throw new Error('Worktree preparation is incomplete');
  if (stageId === 'tracker-publish' && publicationApproved && state.stages?.['to-ticket']?.status === 'waiting' && state.stages['to-ticket'].code === 'REVIEW_REQUIRED' && worktreeRef) {
    const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
    const { inspectPlanSet } = await import('./plan-review.mjs');
    const review = await inspectPlanSet({ root, planSetId: record.plan_set_id, phase: 'planning' });
    if (review.status !== 'pass') throw new Error(`Current independent plan review is required: ${review.reason}`);
    const previous = state.stages['to-ticket'];
    const priorInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    const priorEnvelope = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${previous.execution_id}/return.json` });
    await validateSkillReturn({ root, input: priorInput, envelope: priorEnvelope });
    const priorResult = await readSkillSessionJson({ root, session_directory: session, path: previous.result_ref });
    if (priorEnvelope.result && !isDeepStrictEqual(priorEnvelope.result, priorResult)) throw new Error('Stored plan result does not match its return');
    if (priorResult.questions?.length) throw new Error('Unanswered questions prevent automatic plan finalization');
    const executionId = `plan-finalize-${randomUUID()}`;
    const input = { ...priorInput, execution_id: executionId };
    const result = { ...priorResult, execution_id: executionId, status: 'completed', code: 'OK', review_request: null };
    const prefix = `runtime/executions/${executionId}`;
    const envelope = { schema_version: 1, execution_id: executionId, skill: 'to-ticket', status: 'completed', code: 'OK', result_ref: `${prefix}/result.json`, result };
    await validateSkillReturn({ root, input, envelope });
    await writeExecutionInput(root, storedStageInput(input), record.plan_set_id);
    await mkdir(join(session, prefix), { recursive: true, mode: 0o700 });
    await writeFile(join(session, prefix, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(session, prefix, 'return.json'), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const binding = { model: previous.model, reasoning_effort: previous.reasoning_effort };
    await recordExecutionState({ root, input, binding, status: 'running', owner: await processIdentity(process.pid) });
    await recordExecutionState({ root, input, binding, status: 'completed', code: 'OK', result_ref: envelope.result_ref });
    state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' });
  }
  if (stageId === 'tracker-publish' && (!publicationApproved || state.stages?.['to-ticket']?.status !== 'completed' || state.stages?.['to-ticket']?.code !== 'OK')) throw new Error('Completed to-ticket and user publication approval are required');
  if (publicationApproved && stageId !== 'tracker-publish') throw new Error('Publication approval is only valid for tracker-publish');
  if (specOverwriteApproved && stageId !== 'spec-me') throw new Error('Spec overwrite approval is only valid for spec-me');
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
  const stage = { id: stageId, skill: stageId, scope: prepared.scope, needs: [], inputs: [], outputs: [], conditions: [], gates: [] };
  const input_refs = [];
  const producer_result_refs = {};
  const lastStage = state.current_stage;
  const last = lastStage && lastStage !== 'workflow-compose' ? state.stages?.[lastStage] : null;
  if (last?.code === 'SUBTASK_REQUIRED') throw new Error('Legacy SUBTASK_REQUIRED execution cannot be resumed: the pending subagent identity and result are not recorded; in-place recovery is unsupported. Preserve the session artifacts and report this limitation.');
  let transition;
  if (last && (lastStage !== stageId || Object.hasOwn(REVISION_TARGETS, last.code))) {
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
    workflowBinding = record.workflow_binding || null;
    if (workflowBinding) {
      if (orchestratorSession && workflowBinding.provider !== orchestratorSession.provider) throw new Error('Workflow binding provider must match the orchestrator provider');
      provider = workflowBinding.provider;
    }
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
  const crossStageRevision = transition && lastStage !== stageId && REVISION_TARGETS[transition.code] === stageId;
  if (feedback !== null && crossStageRevision && !previous) {
    conversation = { previous_result_ref: transition.result_ref };
  } else if (feedback !== null) {
    let interrupted = previous?.status === 'failed' && previous.code === 'EXECUTION_ERROR' && previous.reason === 'Execution interrupted after its processes exited' && !previous.result_ref;
    if (!interrupted && previous?.status === 'running' && !previous.result_ref) {
      await assertExecutionStopped(previous, { root, session: taskSession });
      interrupted = true;
    }
    const reviewWaiting = previous?.status === 'waiting' && previous.code === 'REVIEW_REQUIRED' && previous.result_ref;
    const revisionWaiting = previous?.status === 'waiting' && previous.result_ref && REVISION_TARGETS[previous.code] === stageId;
    if (!interrupted && !(reviewWaiting || revisionWaiting || crossStageRevision || (previous?.status === 'blocked' && previous.result_ref))) throw new Error('Feedback requires a review, matching revision or blocked stage, or a confirmed interrupted stage');
    const prefix = `runtime/executions/${previous.execution_id}`;
    const previousInput = await readExecutionInput({ root, execution_id: previous.execution_id });
    if (previousInput.skill !== stage.skill || previousInput.context?.stage_id !== stageId || previousInput.workspace_root !== root || previousInput.session_directory !== taskSession || previousInput.context?.worktree_ref !== worktreeRef) throw new Error('Feedback target does not match stage state');
    if (!interrupted) {
      const previousSession = await resolveSkillSession(root, previous.result_session_directory || session);
      if (previousSession !== taskSession) throw new Error('Feedback target belongs to a different worktree session');
      const previousReturn = await readSkillSessionJson({ root, session_directory: taskSession, path: `${prefix}/return.json` });
      await validateSkillReturn({ root, input: previousInput, envelope: previousReturn });
      if (previousReturn.result_ref !== previous.result_ref || previousReturn.code !== previous.code || ((reviewWaiting || revisionWaiting) && previousReturn.status !== 'action_required')) throw new Error('Feedback target does not match stage state');
    }
    const neverStarted = interrupted && previous.runner_managed && !previous.child && !previousInput.context?.resume_session_id;
    const sessionInfo = neverStarted ? null : await executionSession({ root, session: taskSession, executionId: previous.execution_id, worktreeRef });
    if (sessionInfo) provider = sessionInfo.provider;
    else if (previousInput.context?.provider) provider = previousInput.context.provider;
    if (interrupted) interruptedAnswers = join(taskSession, prefix, 'answers.json');
    const priorResult = crossStageRevision ? transition.result_ref : previous.result_ref || (interrupted ? previousInput.context?.previous_result_ref : null);
    conversation = { ...(priorResult ? { previous_result_ref: priorResult } : {}), ...(sessionInfo ? { resume_session_id: sessionInfo.session_id, resume_provider: sessionInfo.provider } : {}), ...(interrupted && stage.skill === 'spec-me' ? { interrupted_execution_id: previous.execution_id, ...(previousInput.context?.approved_spec_overwrites ? { approved_spec_overwrites: previousInput.context.approved_spec_overwrites } : {}) } : {}) };
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
    const sessionInfo = await executionSession({ root, session: taskSession, executionId: previous.execution_id, worktreeRef });
    provider = sessionInfo.provider;
    const result = previousReturn.result || await readSkillSessionJson({ root, session_directory: previousSession, path: previous.result_ref });
    const batchAnswers = await collectAnswers(taskSession, prefix, result.questions, answer);
    if (!batchAnswers.complete) return { waiting_for_answers: true, questions: result.questions, answers: batchAnswers.answers };
    answer = batchAnswers.answers;
    conversation = { previous_result_ref: previous.result_ref, resume_session_id: sessionInfo.session_id, resume_provider: sessionInfo.provider, ...(previousInput.context?.approved_spec_overwrites ? { approved_spec_overwrites: previousInput.context.approved_spec_overwrites } : {}) };
  }
  if (workflowBinding && provider !== workflowBinding.provider) throw new Error('Workflow binding provider must match the resumed session');
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
  const input = { schema_version: 1, execution_id, skill: stage.skill, workspace_root: root, session_directory: taskSession, scope: stage.scope, input_refs, context: { ...(codexSessionId ? { codex_session_id: codexSessionId } : {}), ...(orchestratorSession ? { orchestrator_session_id: orchestratorSession.session_id, orchestrator_provider: orchestratorSession.provider } : {}), provider, ...(workflowBinding ? { workflow_binding: workflowBinding } : {}), stage_id: stage.id, control_session_directory: session, workflow_ref: workflowRef, ...conversation, ...(transition ? { transition } : {}), ...(Object.keys(producer_result_refs).length ? { producer_result_refs } : {}), ...(worktree_ref ? { worktree_ref } : {}), ...(plan_set_id ? { plan_set_id } : {}), ...(publicationApproved ? { publication_approved: true } : {}), ...(review_admission ? { review_admission } : {}), ...(plan_review_admission ? { plan_review_admission } : {}), conditions: stage.conditions, gates: stage.gates, outputs: stage.outputs } };
  if (approvedSpecOverwrites) input.context.approved_spec_overwrites = approvedSpecOverwrites;
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
