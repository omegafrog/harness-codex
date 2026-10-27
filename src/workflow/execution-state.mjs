import { mkdir, rename, rm, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveSkillSession, readSkillSessionJson } from './skill-execution.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { refreshWorkflowProgress } from './startup-state.mjs';

export async function recordExecutionState({ root, input, binding, status, code = null, result_ref = null, reason = null }) {
  const session = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  const owner = input.context?.codex_session_id || process.env.CODEX_THREAD_ID;
  const stage = input.context?.stage_id || input.skill;
  if (!owner || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stage)) throw new Error('Workflow session identity and valid stage ID required');
  const directory = 'runtime/orchestrator';
  await assertWorkspaceTarget(session, `${directory}/state.json`);
  await mkdir(join(session, directory), { recursive: true });
  const lock = join(session, directory, '.state.lock');
  await mkdir(lock);
  try {
    let state;
    try { state = await readSkillSessionJson({ root, session_directory: session, path: `${directory}/state.json` }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state && (state.schema_version !== 1 || state.codex_session_id !== owner)) throw new Error('Workflow state ownership mismatch');
    state ||= { schema_version: 1, codex_session_id: owner, workflow_ref: null, stages: {} };
    const previous = state.stages?.[stage];
    if (status === 'running' && previous?.status === 'running' && previous.execution_id !== input.execution_id) throw new Error('Stage already running');
    if (status !== 'running' && previous?.execution_id !== input.execution_id) throw new Error('Stage execution changed');
    const now = new Date().toISOString();
    const entry = { ...previous, status, execution_id: input.execution_id, model: binding.model, reasoning_effort: binding.reasoning_effort, code, result_ref, result_session_directory: input.session_directory, reason, updated_at: now };
    if (status === 'running') {
      entry.started_at = now;
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
    await refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [{ session_directory: session }], issues: [], codex_session_id: owner }, 'SkillExecution');
  } finally { await rm(lock, { recursive: true }); }
}
