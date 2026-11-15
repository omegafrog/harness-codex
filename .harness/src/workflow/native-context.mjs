import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorktreeRecord } from './worktrees.mjs';
import { readExecutionInput, validateSkillInput } from './skill-execution.mjs';

// Only an exact parent agent/session identity may supply stage context to native review hooks.
// The Claude Code stage subagent has no Agent tool, so the main orchestrator session dispatches the independent
// reviewer on the running stage's behalf. `mainSession` accepts that session (a hook event without an agent_id) when
// exactly one native stage is running in this workspace; any agent inside a stage still needs its exact identity.
export async function nativeHookContext(root, parentIds, { mainSession = false } = {}) {
  if (!root || !Array.isArray(parentIds)) return null;
  try {
    const workspace = await realpath(root);
    const session = join(workspace, '.io');
    let record;
    try { record = parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8')); }
    catch { return null; }
    if (record.state !== 'active' || await realpath(record.workspace) !== workspace || record.session_directory !== session) return null;
    let state;
    try { const workflow = JSON.parse(await readFile(join(session, 'runtime/orchestrator/workflow.json'), 'utf8')); state = workflow.state || workflow; }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')); }
    // The main session dispatches a reviewer while the current stage has handed control back (waiting for the review),
    // so its context is the current stage's execution rather than a running native agent.
    const current = mainSession ? state.stages?.[state.current_stage] : null;
    const matches = mainSession
      ? (current && ['running', 'waiting'].includes(current.status) && current.execution_id ? [current] : [])
      : Object.values(state.stages || {}).filter((stage) => stage.status === 'running' && stage.native_managed && stage.native_agent_id && parentIds.includes(stage.native_agent_id));
    if (matches.length !== 1) return null;
    const input = await readExecutionInput({ root: workspace, execution_id: matches[0].execution_id });
    await validateSkillInput({ root: workspace, input });
    if (input.session_directory !== session || input.context?.worktree_ref !== join(session, 'worktree.json')) return null;
    return { root: workspace, session, executionId: input.execution_id, planSetId: input.context?.plan_set_id || null };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
