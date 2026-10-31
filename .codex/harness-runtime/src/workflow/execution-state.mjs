import { mkdir, rename, rm, writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { resolveSkillSession, readSkillSessionJson, validateSkillReturn } from './skill-execution.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { refreshWorkflowProgress } from './startup-state.mjs';
import { parseWorktreeRecord, recordWorktreeStage } from './worktrees.mjs';
import { WORKTREE_STAGE } from './worktree-stages.mjs';

const ACTIVE_WORKFLOW_STATES = new Set(['created', 'running', 'waiting', 'blocked']);

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
  await assertWorkspaceTarget(session, `${directory}/workflow.json`);
  await mkdir(join(session, directory), { recursive: true });
  const lock = join(session, directory, '.state.lock');
  const composeSnapshot = join(session, directory, `.compose-state-${input.execution_id}.json`);
  await mkdir(lock);
  try {
    let workflow;
    try { workflow = await readSkillSessionJson({ root, session_directory: session, path: `${directory}/workflow.json` }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    workflow ||= { schema_version: 1, stages: [] };
    if (input.skill === 'workflow-compose' && status === 'completed') {
      if (!Array.isArray(workflow.stages) || !workflow.stages.length || !workflow.stages[0]?.id) throw new Error('Completed workflow composition requires a workflow with an initial stage');
      if (code !== 'OK' || result_ref !== `runtime/executions/${input.execution_id}/result.json`) throw new Error('Completed composition requires its verified OK result');
      const envelope = await readSkillSessionJson({ root, session_directory: session, path: `runtime/executions/${input.execution_id}/return.json` });
      if (envelope.status !== 'completed' || envelope.code !== code || envelope.result_ref !== result_ref) throw new Error('Compose completion does not match its validated return');
      await validateSkillReturn({ root, input, envelope });
    }
    const workflowStage = input.context?.parent_stage_id || stage;
    if (input.context?.workflow_ref && !workflow.stages?.some((item) => item.id === workflowStage)) throw new Error('Current stage is not in the workflow');
    let state = workflow.state;
    let migrated = false;
    if (!state) {
      try { state = await readSkillSessionJson({ root, session_directory: session, path: `${directory}/state.json` }); migrated = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (state && state.schema_version !== 1) throw new Error('Invalid workflow state schema');
    if (state && input.context?.workflow_ref && state.workflow_ref !== input.context.workflow_ref) throw new Error('Workflow reference mismatch');
    if (status === 'running' && input.skill === 'workflow-compose' && state && ACTIVE_WORKFLOW_STATES.has(state.status) && state.stages?.[stage]?.status !== 'running') {
      const recompose = input.context?.recompose === true && state.workflow_ref === 'runtime/orchestrator/workflow.json'
        && state.stages?.[stage]?.status === 'completed'
        && !Object.entries(state.stages || {}).some(([id, entry]) => id !== stage && entry.status === 'running');
      if (!recompose) throw new Error('Workflow already active; explicit idle recomposition is required');
    }
    if (status === 'completed' && input.skill === 'workflow-compose') {
      const baseline = JSON.parse(await readFile(composeSnapshot, 'utf8'));
      if (!isDeepStrictEqual(state, baseline)) throw new Error('Compose modified orchestrator state; state must be preserved exactly');
    }
    state ||= { schema_version: 1, codex_session_id: codexSessionId, workflow_ref: null, stages: {} };
    if (codexSessionId) state.codex_session_id = codexSessionId;
    const previous = state.stages?.[stage];
    if (status === 'running' && previous?.status === 'running' && previous.execution_id !== input.execution_id) {
      if (await processAlive(previous.owner) || await processAlive(previous.child)) throw new Error('Stage already running');
      previous.status = 'failed'; previous.code = 'EXECUTION_ERROR'; previous.reason = 'Execution interrupted after its processes exited'; previous.finished_at = new Date().toISOString();
    }
    if (status !== 'running' && previous?.execution_id !== input.execution_id && !(input.skill === 'workflow-compose' && status === 'completed' && !previous)) throw new Error('Stage execution changed');
    const now = new Date().toISOString();
    const priorWorkflowStatus = previous?.prior_workflow_status ?? (input.skill === 'workflow-compose' && state.status !== 'running' ? state.status : null);
    const entry = { ...previous, status, execution_id: input.execution_id, model: binding.model, reasoning_effort: binding.reasoning_effort, code, result_ref, result_session_directory: input.session_directory, reason, updated_at: now };
    if (status === 'running') {
      if (input.skill === 'workflow-compose' && priorWorkflowStatus) {
        entry.prior_workflow_status = priorWorkflowStatus;
        entry.prior_current_stage = state.current_stage;
      }
      entry.started_at = now;
      if (previous?.execution_id !== input.execution_id) { delete entry.child; delete entry.finished_at; }
      if (owner) entry.owner = owner;
      if (child) entry.child = child;
      if (previous && previous.execution_id !== input.execution_id) entry.attempts = [...(previous.attempts || []), Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'attempts'))];
    }
    else entry.finished_at = now;
    state.stages = { ...state.stages, [stage]: entry };
    state.status = input.skill === 'workflow-compose' && status === 'completed' ? (priorWorkflowStatus || 'created') : status === 'completed' || status === 'action_required' ? 'waiting' : status;
    if (status === 'action_required') entry.status = 'waiting';
    if (input.skill === 'workflow-compose' && status === 'completed') {
      state.current_stage = priorWorkflowStatus && workflow.stages?.some((item) => item.id === previous?.prior_current_stage)
        ? previous.prior_current_stage : workflow.stages?.[0]?.id || null;
    } else state.current_stage = workflowStage;
    const stageSkill = state.current_stage === WORKTREE_STAGE.WORKFLOW_COMPOSE ? WORKTREE_STAGE.WORKFLOW_COMPOSE : workflow.stages?.find((item) => item.id === state.current_stage)?.skill;
    if (!Object.values(WORKTREE_STAGE).includes(stageSkill)) throw new Error('Current stage is not in the workflow or stage enum');
    state.updated_at = now;
    if (input.skill === 'workflow-compose' && status === 'completed') state.workflow_ref = 'runtime/orchestrator/workflow.json';
    workflow.state = state;
    if (input.skill === 'workflow-compose' && status === 'running') {
      await writeFile(composeSnapshot, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const temporary = join(session, directory, `.workflow-${randomUUID()}.json`);
    try { await writeFile(temporary, JSON.stringify(workflow, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, join(session, directory, 'workflow.json')); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    if (input.context?.worktree_ref && state.current_stage) {
      const reference = input.context.worktree_ref;
      const record = parseWorktreeRecord(await readFile(reference, 'utf8'));
      const worktreeSession = await resolveSkillSession(root, record.session_directory);
      if (reference !== join(worktreeSession, 'worktree.json')) throw new Error('Invalid canonical worktree reference');
      await recordWorktreeStage({ workspace_root: record.workspace, repository_root: record.return_root, current_stage: stageSkill });
    }
    if (migrated) await unlink(join(session, directory, 'state.json'));
    await refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [{ session_directory: session }], issues: [], codex_session_id: codexSessionId }, 'SkillExecution');
  } finally { await rm(lock, { recursive: true }); }
}
