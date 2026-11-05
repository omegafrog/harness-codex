import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, unlink, writeFile, rm, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillReturn } from './skill-execution.mjs';
import { assertExecutionStopped, processIdentity, recordExecutionState } from './execution-state.mjs';

const execFileAsync = promisify(execFile);
const directory = 'runtime/orchestrator/stage-results';
const deliveryRequestId = (input) => createHash('sha256').update(`${input.context?.worktree_ref || ''}:${input.execution_id}`).digest('hex');

async function save(session, path, value) {
  await assertWorkspaceTarget(session, path);
  const target = join(session, path), temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(target, '..'), { recursive: true });
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function locked(session, executionId, callback) {
  const lock = join(session, directory, `.${executionId}.lock`);
  await mkdir(join(session, directory), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ ...(await processIdentity(process.pid) || {}), pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') { await rm(lock, { recursive: true, force: true }); throw error; }
      const owner = await readFile(join(lock, 'owner.json'), 'utf8').then(JSON.parse, () => null);
      let stale = false;
      if (owner?.pid && owner.boot && owner.start) {
        const current = await processIdentity(owner.pid);
        stale = !current || current.boot !== owner.boot || current.start !== owner.start;
      } else if (owner?.pid) {
        try { process.kill(owner.pid, 0); } catch (processError) { stale = processError.code === 'ESRCH'; }
      } else {
        stale = Date.now() - (await stat(lock)).mtimeMs > 5_000;
      }
      if (stale) { await rm(lock, { recursive: true, force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await callback(); } finally { await rm(lock, { recursive: true, force: true }); }
}

function eventPayload(input, envelope) {
  const result = envelope.result;
  const questions = result?.questions || [];
  const event = {
    schema_version: 1,
    worktree_ref: input.context?.worktree_ref || null,
    execution_id: input.execution_id,
    status: envelope.status,
    code: envelope.code,
    summary: (result?.summary || envelope.reason || envelope.code).slice(0, 1200),
    questions,
    questions_complete: true,
    result_ref: envelope.result_ref,
    created_at: new Date().toISOString(),
    delivery: { status: 'pending', request_id: deliveryRequestId(input) },
  };
  if (Buffer.byteLength(JSON.stringify(event)) > 12_000) {
    event.questions = [];
    event.questions_complete = false;
    event.omitted_question_count = questions.length;
    event.summary = `${event.summary} (questions omitted from notification; fetch ${event.result_ref})`.slice(0, 1200);
  }
  return event;
}

async function deliver(session, input, event) {
  const expected = input.context?.orchestrator_session_id;
  if (!expected) return { status: 'unsupported', reason: 'orchestrator_session_missing' };
  let identity;
  try { identity = JSON.parse((await execFileAsync('ghostex', ['agents', 'whoami', '--json'], { cwd: input.workspace_root, timeout: 5_000 })).stdout); }
  catch (error) { if (error.killed || error.code === 'ETIMEDOUT') throw error; return { status: 'unsupported', reason: error.code === 'ENOENT' ? 'ghostex_unavailable' : `host_identity_unavailable:${String(error.code || error.name).slice(0, 40)}` }; }
  if (identity.agentSessionId !== expected || !identity.globalRef) return { status: 'unsupported', reason: 'session_identity_mismatch' };
  const bodyPath = join(session, `.stage-result-${randomUUID()}.json`);
  await writeFile(bodyPath, JSON.stringify(event), { flag: 'wx', mode: 0o600 });
  try {
    await execFileAsync('ghostex', ['agents', 'send', identity.globalRef, '--body-file', bodyPath, '--queue', '--request-id', event.delivery.request_id], { cwd: input.workspace_root, timeout: 5_000 });
    return { status: 'sent' };
  } finally { await unlink(bodyPath).catch(() => {}); }
}

async function deliverPending(session, input, event) {
  if (event.delivery.status === 'sent') return event;
  event.delivery.status = 'pending';
  event.delivery.updated_at = new Date().toISOString();
  await save(session, `${directory}/${input.execution_id}.json`, event);
  try {
    const outcome = await deliver(session, input, event);
    event.delivery.status = outcome.status;
    if (outcome.reason) event.delivery.reason = outcome.reason;
    else delete event.delivery.reason;
  }
  catch (error) { event.delivery.status = 'pending'; event.delivery.error = error.message.slice(0, 300); }
  event.delivery.updated_at = new Date().toISOString();
  await save(session, `${directory}/${input.execution_id}.json`, event);
  return event;
}

export async function publishStageResultEvent({ root, input, envelope = null, binding = { model: null, reasoning_effort: null }, reason = null, error = null, hostDelivery = true }) {
  if (!input?.execution_id || (envelope && envelope.execution_id !== input.execution_id)) throw new Error('Stage result execution ID mismatch');
  const canonicalInput = await readExecutionInput({ root, execution_id: input.execution_id });
  if (canonicalInput.skill !== input.skill || (input.context?.worktree_ref && canonicalInput.context?.worktree_ref !== input.context.worktree_ref) || (input.context?.control_session_directory && canonicalInput.context?.control_session_directory !== input.context.control_session_directory)) throw new Error('Stage result input does not match the persisted execution');
  input = canonicalInput;
  let verified = false;
  if (envelope) {
    try { await validateSkillReturn({ root, input, envelope }); verified = true; }
    catch (validationError) { reason ||= validationError.message; }
  }
  const status = verified ? envelope.status : error?.name === 'AbortError' ? 'cancelled' : 'failed';
  const code = verified ? envelope.code : status === 'cancelled' ? 'CANCELLED' : 'EXECUTION_ERROR';
  const session = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  const path = `${directory}/${input.execution_id}.json`;
  return locked(session, input.execution_id, async () => {
  await recordExecutionState({ root, input, binding, status, code, result_ref: verified ? envelope.result_ref : null, reason: reason || error?.message });
  let event;
  try { event = await readSkillSessionJson({ root, session_directory: session, path }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (event && (event.execution_id !== input.execution_id || event.worktree_ref !== (input.context?.worktree_ref || null) || !event.delivery || event.delivery.request_id !== deliveryRequestId(input))) throw new Error('Stale stage result event');
  if (event?.delivery.status === 'sent') return event;
  event ||= eventPayload(input, verified ? envelope : { status, code, result_ref: null, reason: reason || error?.message });
  if (event.delivery.status === 'sent') return event;
  const payload = eventPayload(input, verified ? envelope : { status, code, result_ref: null, reason: reason || error?.message });
  event.status = status;
  event.code = code;
  event.result_ref = verified ? envelope.result_ref : null;
  event.summary = payload.summary;
  event.questions = payload.questions;
  event.questions_complete = payload.questions_complete;
  if (payload.omitted_question_count) event.omitted_question_count = payload.omitted_question_count;
  else delete event.omitted_question_count;
  event.delivery.status = 'pending';
  event.delivery.updated_at = new Date().toISOString();
  await save(session, path, event);
  if (hostDelivery) {
    return deliverPending(session, input, event);
  }
  await save(session, path, event);
  return event;
  });
}

export async function validateStageListenerTarget({ root, worktree_ref, execution_id }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(execution_id || '') || !worktree_ref) throw new Error('Canonical worktree reference and execution ID are required');
  const { parseWorktreeRecord } = await import('./worktrees.mjs');
  const record = parseWorktreeRecord(await readFile(worktree_ref, 'utf8'));
  if (record.state !== 'active' || record.workspace !== root || worktree_ref !== join(record.session_directory, 'worktree.json')) throw new Error('Worktree identity mismatch');
  const taskSession = await resolveSkillSession(root, record.session_directory);
  const input = await readExecutionInput({ root, execution_id });
  if (input.context?.worktree_ref !== worktree_ref || input.workspace_root !== root || input.session_directory !== taskSession) throw new Error('Execution input does not belong to the canonical worktree');
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || taskSession);
  return { task_session: taskSession, control_session: controlSession, input, record };
}

export async function waitForStageResult({ root, worktree_ref, execution_id }) {
  const { task_session: taskSession, control_session: controlSession, input } = await validateStageListenerTarget({ root, worktree_ref, execution_id });
  const statePath = input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json';
  const workflow = await readSkillSessionJson({ root, session_directory: controlSession, path: statePath });
  const state = workflow.state || workflow;
  const stage = state.stages?.[state.current_stage];
  if (stage?.execution_id !== execution_id) throw new Error('Execution is not current in the canonical workflow');
  const path = `${directory}/${execution_id}.json`;
  try {
    const event = await readSkillSessionJson({ root, session_directory: controlSession, path });
    if (event.execution_id !== execution_id || event.worktree_ref !== worktree_ref || event.delivery?.request_id !== deliveryRequestId({ execution_id, context: { worktree_ref } })) throw new Error('Stale stage result event');
    if (!event.result_ref) {
      const allowedFailure = event.status === 'failed' && stage.status === 'failed' && stage.code === event.code && ['EXECUTION_ERROR', 'INVALID_INPUT', 'ARTIFACT_WRITE_FAILED'].includes(event.code);
      const allowedCancellation = event.status === 'cancelled' && stage.status === 'cancelled' && stage.code === event.code && event.code === 'CANCELLED';
      if (!allowedFailure && !allowedCancellation) throw new Error('Result-less event does not match a terminal failed or cancelled stage');
      return locked(controlSession, execution_id, () => deliverPending(controlSession, input, event));
    }
    if (event.result_ref !== `runtime/executions/${execution_id}/result.json`) throw new Error('Invalid stage result reference');
    const result = await readSkillSessionJson({ root, session_directory: taskSession, path: event.result_ref });
    const envelope = { schema_version: 1, execution_id, skill: input.skill, status: event.status, code: event.code, result_ref: event.result_ref, result };
    await validateSkillReturn({ root, input, envelope });
    await publishStageResultEvent({ root, input, envelope, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, hostDelivery: true });
    return envelope;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const resultPath = `runtime/executions/${execution_id}/result.json`;
  let envelope;
  try {
    const result = await readSkillSessionJson({ root, session_directory: taskSession, path: resultPath });
    envelope = { schema_version: 1, execution_id, skill: input.skill, status: result.status, code: result.code, result_ref: resultPath, result };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    try { envelope = await readSkillSessionJson({ root, session_directory: taskSession, path: `runtime/executions/${execution_id}/return.json` }); }
    catch (returnError) {
      if (returnError.code !== 'ENOENT' && !(returnError instanceof SyntaxError)) throw returnError;
      if (!stage.owner && !stage.child) throw Object.assign(new Error('Stage has not reported terminal evidence'), { code: 'ENOENT' });
      try { await assertExecutionStopped(stage, { root, session: taskSession }); }
      catch (stoppedError) {
        if (/^Stage already running/.test(stoppedError.message)) throw Object.assign(stoppedError, { code: 'ENOENT' });
        throw stoppedError;
      }
      const reason = 'Stage runner stopped before saving a validated return';
      await publishStageResultEvent({ root, input, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, reason, error: new Error(reason), hostDelivery: true });
      return readSkillSessionJson({ root, session_directory: controlSession, path });
    }
  }
  await validateSkillReturn({ root, input, envelope });
  await publishStageResultEvent({ root, input, envelope, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, hostDelivery: true });
  return envelope;
}
