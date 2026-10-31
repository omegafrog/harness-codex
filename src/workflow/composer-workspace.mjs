import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkflowWorktree, finishWorkflowWorktree, parseWorktreeRecord } from './worktrees.mjs';
import { resolveSkillSession } from './skill-execution.mjs';
import { writeExecutionInput } from './execution-input.mjs';

export async function createComposerWorkspace({ root, plan_set_id, request, execution_id, codex_session_id, recompose_worktree_ref = null }) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('Initial request is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(execution_id || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(codex_session_id || '')) throw new Error('Execution ID and actual Codex session ID are required');
  if (typeof plan_set_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan_set_id)) throw new Error('Explicit plan_set_id is required');
  let record;
  if (recompose_worktree_ref) {
    if (typeof recompose_worktree_ref !== 'string') throw new Error('Recompose requires a canonical worktree reference');
    const session = await resolveSkillSession(root, recompose_worktree_ref.slice(0, -'/worktree.json'.length));
    if (recompose_worktree_ref !== join(session, 'worktree.json')) throw new Error('Recompose worktree reference is not canonical');
    record = parseWorktreeRecord(await readFile(recompose_worktree_ref, 'utf8'));
    if (record.state !== 'active' || record.session_directory !== session || await realpath(record.workspace) !== await realpath(root) || record.plan_set_id !== plan_set_id) throw new Error('Recompose requires the active, matching worktree and plan set');
    const current = JSON.parse(await readFile(join(session, 'runtime/orchestrator/workflow.json'), 'utf8'));
    const state = current.state;
    if (state?.workflow_ref !== 'runtime/orchestrator/workflow.json' || state.stages?.['workflow-compose']?.status !== 'completed' || Object.values(state.stages || {}).some((entry) => entry.status === 'running')) {
      throw new Error('Recompose requires a completed composition and no running stages');
    }
  } else {
    record = await createWorkflowWorktree({ workspace_root: root, plan_set_id });
  }
  const input = {
    schema_version: 1, execution_id, skill: 'workflow-compose',
    workspace_root: record.workspace, shared_guidance_root: record.return_root,
    session_directory: record.session_directory, scope: request, input_refs: [],
    context: { plan_set_id: record.plan_set_id, worktree_ref: join(record.session_directory, 'worktree.json'), codex_session_id, stage_id: 'workflow-compose', ...(recompose_worktree_ref ? { recompose: true } : {}) },
  };
  try {
    const input_path = await writeExecutionInput(record.workspace, input, record.plan_set_id);
    return { ...record, input_path };
  } catch (error) {
    if (recompose_worktree_ref) throw error;
    try {
      const cleanup = await finishWorkflowWorktree({ workspace_root: record.workspace, repository_root: record.return_root, worktree_id: record.worktree_id, outcome: 'failed' });
      error.message += `; compose input cleanup=${cleanup.state}`;
    } catch (cleanupError) {
      error.message += `; compose input cleanup failed: ${cleanupError.message}`;
    }
    throw error;
  }
}

// Only the deterministic worktree lifecycle runs outside the model sandbox.
export async function prepareComposerWorkspace({ root, session, input, inputPath }) {
  if (!input.context?.worktree_ref) throw new Error('Create the worktree before preparing compose input');
  const reference = input.context.worktree_ref;
  const directory = await resolveSkillSession(root, session);
  if (reference !== join(directory, 'worktree.json')) throw new Error('Compose worktree reference does not match session');
  const record = parseWorktreeRecord(await readFile(reference, 'utf8'));
  if (record.state !== 'active' || record.workspace !== root || record.session_directory !== directory) throw new Error('Compose input must belong to the active worktree');
  if (input.workspace_root !== record.workspace || input.session_directory !== directory || input.context.control_session_directory) throw new Error('Compose execution must stay in its worktree');
  if (input.context.plan_set_id !== record.plan_set_id || inputPath.split('/')[1] !== record.plan_set_id) throw new Error('Compose input plan_set_id mismatch');
  return record;
}
