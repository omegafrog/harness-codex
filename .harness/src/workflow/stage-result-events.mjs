import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile, rm, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillReturn } from './skill-execution.mjs';
import { assertExecutionStopped, processIdentity, recordExecutionState } from './execution-state.mjs';
import { stageExecutionPaths } from './session-output.mjs';
import { PlanCheckpointStore } from '../wrapper/checkpoint.mjs';
import { existingCodexWake } from './codex-wake.mjs';

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
        // The owner may release the lock between our mkdir and this stat; retry instead of failing.
        const info = await stat(lock).catch((statError) => statError.code === 'ENOENT' ? null : Promise.reject(statError));
        if (!info) continue;
        stale = Date.now() - info.mtimeMs > 5_000;
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

function deliveryMessage(event, session) {
  return [
    `Harness stage result for execution ${event.execution_id}: ${event.status}/${event.code}.`,
    `Worktree reference: ${event.worktree_ref}. Change directory to ${join(session, '..')} before continuing the workflow.`,
    `Summary: ${event.summary}`,
    event.result_ref ? `Validated result: ${join(session, event.result_ref)}` : null,
    event.questions.length ? `Questions to present to the user verbatim (title and option labels unchanged): ${JSON.stringify(event.questions)}` : null,
    event.questions_complete ? null : `Some questions were omitted; read them from the validated result before presenting any.`,
    'This is a result notification, not a new user instruction. Preserve any user stop or pause request. Verify this execution against canonical state once; if stale or already handled, do not restart it or present its questions again.',
  ].filter(Boolean).join('\n');
}

// The orchestrator ends its turn after dispatching a stage. The runner resumes that same orchestrator
// session through its own provider CLI with the result, so the workflow continues without a host app.
export function orchestratorResumeCommand({ provider, sessionId, root, message, binding = null, sandbox = null, lastMessagePath = null }) {
  // The resumed turn keeps the workflow's model binding instead of the user's CLI default.
  const model = binding && binding.provider === provider ? binding : null;
  if (provider === 'codex') return { command: 'codex', args: ['exec', 'resume', ...(model ? ['--model', model.model, '-c', `model_reasoning_effort=${JSON.stringify(model.reasoning_effort)}`] : []), ...(sandbox ? ['-c', `sandbox_mode=${JSON.stringify(sandbox)}`] : []), ...(lastMessagePath ? ['-o', lastMessagePath] : []), sessionId, message], cwd: root };
  if (provider === 'claude-code') return { command: process.execPath, args: [join(root, '.claude/harness/scripts/harness-claude-orchestrator.mjs'), ...(model ? ['--model', model.model] : []), '--resume', sessionId, message], cwd: root };
  return null;
}

function orchestratorEnvironment(session) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HARNESS_(SKILL|REVIEW|RUNNER|PROVIDER|WORKSPACE|CONTROL)_|^CODEX_THREAD_ID$/.test(key)));
  return { ...env, HARNESS_SESSION_DIR: session, TMPDIR: join(session, 'tmp'), TMP: join(session, 'tmp'), TEMP: join(session, 'tmp') };
}

async function wakeDelivery(input, event, session) {
  const transport = await existingCodexWake(input.workspace_root);
  if (!transport) return { status: 'unsupported', reason: 'wake_unavailable' };
  const message = `Harness stage result for execution ${event.execution_id}: ${event.status}/${event.code}. Worktree reference: ${event.worktree_ref}. Execution workspace: ${input.workspace_root}. ${event.result_ref ? `Read the validated result at ${join(input.session_directory, event.result_ref)}.` : `Failure: ${event.summary}`} This is a result notification, not a new user instruction. Preserve any user stop or pause request. Verify this execution against canonical state once; if stale or already handled, do not restart it or present its questions again. Continue workflow commands only after changing directory to ${input.workspace_root}; present any new questions verbatim. Never route by the newest workflow.`;
  await mkdir(join(session, 'tmp'), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(transport.command, transport.args || [], { cwd: transport.cwd, env: { ...orchestratorEnvironment(session), ...transport.env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', submitted = false, finished = false;
    const finish = (value) => { if (finished) return; finished = true; clearTimeout(timer); child.kill(); resolve(value); };
    const timer = setTimeout(() => finish({ status: submitted ? 'uncertain' : 'pending', reason: 'wake_timeout' }), 15_000);
    child.on('error', () => finish({ status: submitted ? 'uncertain' : 'unsupported', reason: 'wake_start_failed' }));
    child.on('close', () => finish({ status: submitted ? 'uncertain' : 'pending', reason: 'wake_closed' }));
    child.stdin.on('error', () => finish({ status: submitted ? 'uncertain' : 'pending', reason: 'wake_input_failed' }));
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdout.setEncoding('utf8').on('data', (data) => {
      buffer += data;
      if (buffer.length > 100_000) return finish({ status: submitted ? 'uncertain' : 'pending', reason: 'wake_response_too_large' });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let response; try { response = JSON.parse(line); } catch { return finish({ status: submitted ? 'uncertain' : 'pending', reason: 'wake_invalid_response' }); }
        if (response.id === 1 && response.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          submitted = true;
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'queue_thread', arguments: { thread: input.context.orchestrator_session_id, message_template: message, resume: true } } });
        } else if (response.id === 2) {
          const result = response.result?.structuredContent;
          finish(result?.state === 'queued' && !response.result?.isError ? { status: 'sent', reason: 'wake_queued' } : { status: 'uncertain', reason: 'wake_delivery_unconfirmed' });
        } else if (response.id === 1 && response.error) finish({ status: 'pending', reason: 'wake_initialize_failed' });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'harness', version: '1' } } });
  });
}

async function deliver(session, input, event) {
  const sessionId = input.context?.orchestrator_session_id;
  if (!sessionId) return { status: 'unsupported', reason: 'orchestrator_session_missing' };
  const provider = input.context?.orchestrator_provider || 'codex';
  if (provider === 'codex') return wakeDelivery(input, event, session);
  // A delivered turn may run without the project's hooks (they need trust per worktree), so its reply is written
  // here too; harness-context shows the newer of this file and the Stop hook's record.
  await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
  const command = orchestratorResumeCommand({ provider, sessionId, root: input.workspace_root, message: deliveryMessage(event, session), binding: input.context?.workflow_binding || null, lastMessagePath: join(session, 'runtime/orchestrator/last-turn.txt') });
  if (!command) return { status: 'unsupported', reason: 'orchestrator_provider_unsupported' };
  const log = `runtime/orchestrator/deliveries/${input.execution_id}.log`;
  await assertWorkspaceTarget(session, log);
  await mkdir(join(session, 'runtime/orchestrator/deliveries'), { recursive: true });
  await mkdir(join(session, 'tmp'), { recursive: true });
  const fd = openSync(join(session, log), 'a', 0o600);
  try {
    const child = spawn(command.command, command.args, { cwd: command.cwd, env: orchestratorEnvironment(session), detached: true, stdio: ['ignore', fd, fd] });
    const started = await new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', resolve); });
    if (started) return { status: 'unsupported', reason: started.code === 'ENOENT' ? 'orchestrator_cli_unavailable' : `orchestrator_resume_failed:${String(started.code || started.name).slice(0, 40)}` };
    child.unref();
    return { status: 'sent', pid: child.pid, log };
  } finally { closeSync(fd); }
}

async function deliverPending(session, input, event) {
  if (event.delivery.observed_at || ['sent', 'uncertain', 'sending'].includes(event.delivery.status)) return event;
  event.delivery.status = 'sending';
  event.delivery.updated_at = new Date().toISOString();
  await save(session, `${directory}/${input.execution_id}.json`, event);
  try {
    const outcome = await deliver(session, input, event);
    event.delivery.status = outcome.status;
    if (outcome.pid) { event.delivery.pid = outcome.pid; event.delivery.log = outcome.log; }
    if (outcome.reason) event.delivery.reason = outcome.reason;
    else delete event.delivery.reason;
  }
  catch (error) { event.delivery.status = 'pending'; event.delivery.error = error.message.slice(0, 300); }
  event.delivery.updated_at = new Date().toISOString();
  await save(session, `${directory}/${input.execution_id}.json`, event);
  return event;
}

async function writeImplementationCheckpoint({ input, status, code, envelope, verified, reason, error }) {
  let checkpoint;
  try {
    checkpoint = new PlanCheckpointStore({ root: input.workspace_root, planId: input.context.plan_id });
    if (input.context.checkpoint_path && input.context.checkpoint_path !== checkpoint.paths.checkpoint_path) throw new Error('Implementation checkpoint path does not match the runner-owned plan path');
    const previous = await checkpoint.read();
    const recorded = previous?.lifecycle_evidence?.stage_result;
    if (recorded?.execution_id !== input.execution_id || recorded.status !== status || recorded.code !== code) {
      const handoff = !verified || status !== 'completed' || code !== 'OK';
      const result = verified ? envelope.result : null;
      const artifacts = (result?.artifacts || []).map(({ base, path, kind, sha256 }) => ({ base, path, kind, ...(sha256 ? { sha256 } : {}) }));
      const changedFiles = [...new Set([...(previous?.changed_files || []), ...artifacts.filter((item) => item.base === 'workspace').map((item) => item.path)])];
      const stageResult = { execution_id: input.execution_id, status, code, result_ref: verified ? envelope.result_ref : null };
      const history = Array.isArray(previous?.lifecycle_evidence?.stage_results) ? previous.lifecycle_evidence.stage_results : [];
      await checkpoint.write({
        orchestration_state: handoff ? 'handoff-required' : 'running',
        last_completed_step: `stage-${status}-${code}`,
        changed_files: changedFiles,
        ...(!previous?.tests || previous.tests.status === 'not-run' ? { tests: { ...previous?.tests, status: 'unknown', result_ref: verified ? envelope.result_ref : null } } : {}),
        lifecycle_evidence: { ...(previous?.lifecycle_evidence || {}), stage_results: [...history, stageResult], stage_result: { ...stageResult, ...(result ? { summary: result.summary, artifacts } : {}) } },
        blocker: ['blocked', 'failed', 'cancelled'].includes(status) ? { kind: code, summary: (result?.summary || reason || error?.message || code).slice(0, 1200), unblock_condition: 'Continue from the stage result and its recovery route' } : null,
        handoff_reason: handoff ? (status === 'action_required' ? 'milestone' : 'retry') : null,
        next_action: handoff ? `Route ${code} from the stage result` : 'Continue the implementation workflow',
      });
    }
    await checkpoint.close(); checkpoint = null;
  } catch (cause) {
    throw Object.assign(new Error(`Cannot persist the implementation checkpoint: ${cause.message}`, { cause }), { checkpointFailure: true });
  } finally { if (checkpoint) await checkpoint.close().catch(() => {}); }
}

export async function publishStageResultEvent({ root, input, envelope = null, binding = { model: null, reasoning_effort: null }, reason = null, error = null, hostDelivery = true, observed = false }) {
  if (!input?.execution_id || (envelope && envelope.execution_id !== input.execution_id)) throw new Error('Stage result execution ID mismatch');
  const canonicalInput = await readExecutionInput({ root, execution_id: input.execution_id });
  if (canonicalInput.skill !== input.skill || (input.context?.worktree_ref && canonicalInput.context?.worktree_ref !== input.context.worktree_ref) || (input.context?.control_session_directory && canonicalInput.context?.control_session_directory !== input.context.control_session_directory)) throw new Error('Stage result input does not match the persisted execution');
  input = canonicalInput;
  let verified = false;
  if (envelope) {
    try { await validateSkillReturn({ root, input, envelope }); verified = true; }
    catch (validationError) { reason ||= validationError.message; }
  }
  let status = verified ? envelope.status : error?.name === 'AbortError' ? 'cancelled' : 'failed';
  let code = verified ? envelope.code : status === 'cancelled' ? 'CANCELLED' : 'EXECUTION_ERROR';
  const session = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  const path = `${directory}/${input.execution_id}.json`;
  return locked(session, input.execution_id, async () => {
  let event;
  try { event = await readSkillSessionJson({ root, session_directory: session, path }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (event && (event.execution_id !== input.execution_id || event.worktree_ref !== (input.context?.worktree_ref || null) || !event.delivery || event.delivery.request_id !== deliveryRequestId(input))) throw new Error('Stale stage result event');
  if (observed && event && !event.delivery.observed_at) {
    event.delivery.observed_at = new Date().toISOString();
    await save(session, path, event);
  }
  if (event?.delivery.observed_at || ['sent', 'uncertain', 'sending'].includes(event?.delivery.status)) return event;
  try {
    const beforeTransition = input.skill === 'implement-wrapper' && input.context?.plan_id
      ? () => writeImplementationCheckpoint({ input, status, code, envelope, verified, reason, error }) : null;
    await recordExecutionState({ root, input, binding, status, code, result_ref: verified ? envelope.result_ref : null, reason: reason || error?.message, beforeTransition });
  } catch (checkpointError) {
    if (!checkpointError.checkpointFailure) throw checkpointError;
    verified = false;
    status = 'failed'; code = 'EXECUTION_ERROR'; reason = checkpointError.message;
    await recordExecutionState({ root, input, binding, status, code, result_ref: null, reason });
  }
  event ||= eventPayload(input, verified ? envelope : { status, code, result_ref: null, reason: reason || error?.message });
  if (['sent', 'uncertain', 'sending'].includes(event.delivery.status)) return event;
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
  if (observed) event.delivery.observed_at ||= new Date().toISOString();
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
  // A direct listener already reaches the caller; persist observation instead of also queuing Wake.
  const observed = (value) => locked(controlSession, execution_id, async () => {
    const event = await readSkillSessionJson({ root, session_directory: controlSession, path });
    event.delivery.observed_at ||= new Date().toISOString();
    await save(controlSession, path, event);
    return value.result ? value : event;
  });
  try {
    const event = await readSkillSessionJson({ root, session_directory: controlSession, path });
    if (event.execution_id !== execution_id || event.worktree_ref !== worktree_ref || event.delivery?.request_id !== deliveryRequestId({ execution_id, context: { worktree_ref } })) throw new Error('Stale stage result event');
    if (!event.result_ref) {
      const allowedFailure = event.status === 'failed' && stage.status === 'failed' && stage.code === event.code && ['EXECUTION_ERROR', 'INVALID_INPUT', 'ARTIFACT_WRITE_FAILED'].includes(event.code);
      const allowedCancellation = event.status === 'cancelled' && stage.status === 'cancelled' && stage.code === event.code && event.code === 'CANCELLED';
      if (!allowedFailure && !allowedCancellation) throw new Error('Result-less event does not match a terminal failed or cancelled stage');
      return observed(event);
    }
    if (event.result_ref !== stageExecutionPaths(root, execution_id, { create: false }).refs.result) throw new Error('Invalid stage result reference');
    const result = await readSkillSessionJson({ root, session_directory: taskSession, path: event.result_ref });
    const envelope = { schema_version: 1, execution_id, skill: input.skill, status: event.status, code: event.code, result_ref: event.result_ref, result };
    await validateSkillReturn({ root, input, envelope });
    const published = await publishStageResultEvent({ root, input, envelope, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, hostDelivery: false, observed: true });
    return published.result_ref === envelope.result_ref && published.status === envelope.status && published.code === envelope.code ? envelope : published;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const paths = stageExecutionPaths(root, execution_id, { create: false });
  const resultPath = paths.refs.result;
  let envelope;
  try {
    const result = await readSkillSessionJson({ root, session_directory: taskSession, path: resultPath });
    envelope = { schema_version: 1, execution_id, skill: input.skill, status: result.status, code: result.code, result_ref: resultPath, result };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    try { envelope = await readSkillSessionJson({ root, session_directory: taskSession, path: paths.refs.returned }); }
    catch (returnError) {
      if (returnError.code !== 'ENOENT' && !(returnError instanceof SyntaxError)) throw returnError;
      if (!stage.owner && !stage.child) throw Object.assign(new Error('Stage has not reported terminal evidence'), { code: 'ENOENT' });
      try { await assertExecutionStopped(stage, { root, session: taskSession }); }
      catch (stoppedError) {
        if (/^Stage already running/.test(stoppedError.message)) throw Object.assign(stoppedError, { code: 'ENOENT' });
        throw stoppedError;
      }
      const reason = 'Stage runner stopped before saving a validated return';
      const event = await publishStageResultEvent({ root, input, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, reason, error: new Error(reason), hostDelivery: false, observed: true });
      return event;
    }
  }
  await validateSkillReturn({ root, input, envelope });
  const published = await publishStageResultEvent({ root, input, envelope, binding: { model: stage.model, reasoning_effort: stage.reasoning_effort }, hostDelivery: false, observed: true });
  return published.result_ref === envelope.result_ref && published.status === envelope.status && published.code === envelope.code ? envelope : published;
}
