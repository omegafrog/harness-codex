import { mkdir, rename, rm, writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveSkillSession, readSkillSessionJson } from './skill-execution.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { refreshWorkflowProgress } from './startup-state.mjs';

const ACTIVE_WORKFLOW_STATES = new Set(['running', 'waiting', 'blocked']);

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  let boot;
  try { boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, boot, start: fields[19], state: fields[0] };
  } catch (error) { if (error.code === 'ENOENT') return { pid, boot, start: null }; throw error; }
}

async function processAlive(identity) {
  if (!identity || !identity.start || !identity.boot) throw new Error('Stage already running or process identity unavailable; inspection required');
  const current = await processIdentity(identity.pid);
  if (!current) throw new Error('Stage already running or process identity unavailable; inspection required');
  return current.boot === identity.boot && current.start === identity.start && current.state !== 'Z';
}

export async function recordExecutionState({ root, input, binding, status, code = null, result_ref = null, reason = null, owner = null, child = null }) {
  const session = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  const codexSessionId = input.context?.codex_session_id || process.env.CODEX_THREAD_ID || null;
  const stage = input.context?.stage_id || input.skill;
  if ((codexSessionId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(codexSessionId)) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stage)) throw new Error('Invalid Codex session ID or stage ID');
  const directory = 'runtime/orchestrator';
  await assertWorkspaceTarget(session, `${directory}/state.json`);
  await mkdir(join(session, directory), { recursive: true });
  const lock = join(session, directory, '.state.lock');
  await mkdir(lock);
  try {
    let state;
    try { state = await readSkillSessionJson({ root, session_directory: session, path: `${directory}/state.json` }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state && state.schema_version !== 1) throw new Error('Invalid workflow state schema');
    if (state && input.context?.workflow_ref && state.workflow_ref !== input.context.workflow_ref) throw new Error('Workflow reference mismatch');
    if (status === 'running' && input.skill === 'workflow-compose' && state && ACTIVE_WORKFLOW_STATES.has(state.status) && state.stages?.[stage]?.status !== 'running') throw new Error('Workflow already active');
    state ||= { schema_version: 1, codex_session_id: codexSessionId, workflow_ref: null, stages: {} };
    if (codexSessionId) state.codex_session_id = codexSessionId;
    const previous = state.stages?.[stage];
    if (status === 'running' && previous?.status === 'running' && previous.execution_id !== input.execution_id) {
      if (await processAlive(previous.owner) || await processAlive(previous.child)) throw new Error('Stage already running');
      previous.status = 'failed'; previous.code = 'EXECUTION_ERROR'; previous.reason = 'Execution interrupted after its processes exited'; previous.finished_at = new Date().toISOString();
    }
    if (status !== 'running' && previous?.execution_id !== input.execution_id) throw new Error('Stage execution changed');
    const now = new Date().toISOString();
    const entry = { ...previous, status, execution_id: input.execution_id, model: binding.model, reasoning_effort: binding.reasoning_effort, code, result_ref, result_session_directory: input.session_directory, reason, updated_at: now };
    if (status === 'running') {
      entry.started_at = now;
      if (previous?.execution_id !== input.execution_id) { delete entry.child; delete entry.finished_at; }
      if (owner) entry.owner = owner;
      if (child) entry.child = child;
      if (previous && previous.execution_id !== input.execution_id) entry.attempts = [...(previous.attempts || []), Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'attempts'))];
    }
    else entry.finished_at = now;
    state.stages = { ...state.stages, [stage]: entry };
    state.status = status === 'completed' || status === 'action_required' ? 'waiting' : status;
    if (status === 'action_required') entry.status = 'waiting';
    state.current_stage = stage;
    state.updated_at = now;
    if (input.skill === 'workflow-compose' && status === 'completed') state.workflow_ref = 'runtime/orchestrator/workflow.json';
    const temporary = join(session, directory, `.state-${randomUUID()}.json`);
    try { await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, join(session, directory, 'state.json')); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    await refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [{ session_directory: session }], issues: [], codex_session_id: codexSessionId }, 'SkillExecution');
  } finally { await rm(lock, { recursive: true }); }
}
