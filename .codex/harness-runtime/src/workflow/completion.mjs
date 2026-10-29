import { isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadNamedWorkflow } from './loader.mjs';
import { LifecycleGateRegistry, runLifecycleHook } from '../gates/lifecycle.mjs';
import { JsonlEventWriter } from '../eval/journal.mjs';
import { finishWorkflowWorktree } from './worktrees.mjs';
import { sessionDirectory, sessionOutputPath } from './session-output.mjs';
import { inspectWorkspace } from '../eval/workspace-preflight.mjs';

export function completionKindForWorkflow(workflowId) {
  return ({
    'spec-me': 'spec_ready_for_planning',
    'to-ticket': 'plan_set_ready_for_implementation',
    implement: 'plan_implemented',
    'implement-wrapper': 'feature_implemented',
    'frontend-design': 'feature_implemented',
  })[workflowId] || 'workflow_completed';
}

export async function completeWorkflow({ workflow_id, worktree_id = null, workspace_root, base_ref, state = {}, signal = null } = {}) {
  let writer, result, failure;
  try {
    signal?.throwIfAborted();
    if (!isAbsolute(workspace_root || '')) throw new Error('Absolute workspace_root is required');
    if (!/^[a-f0-9]{40}$/.test(base_ref || '')) throw new Error('Starting commit SHA is required');
    const workspace = await inspectWorkspace({ workspaceRoot: workspace_root, cwd: process.cwd() });
    if (!workspace.valid) throw new Error(`Workspace preflight failed: ${workspace.reason}`);
    const workflow = await loadNamedWorkflow(workflow_id, { root: workspace_root });
    const completion_kind = completionKindForWorkflow(workflow.id);
    const finalImplementation = completion_kind === 'feature_implemented';
    const required = ['tracker_sync', ...(finalImplementation ? ['contract_docs'] : []), ...(state.tests?.e2e_failures !== undefined ? ['tests'] : []), ...(['spec-me', 'to-ticket'].includes(workflow.id) ? ['spec_reviews'] : []), ...(workflow.id === 'to-ticket' ? ['plan_review'] : []), ...(['implement', 'implement-wrapper'].includes(workflow.id) ? ['plan_review'] : [])];
    if (workflow.id === 'to-ticket') state = { ...state, plan_review: { ...state.plan_review, phase: 'planning' } };
    if (['implement', 'implement-wrapper'].includes(workflow.id)) state = { ...state, ...(workflow.id === 'implement-wrapper' ? { plan_id: undefined } : {}), plan_review: { ...state.plan_review, plan_id: workflow.id === 'implement-wrapper' ? null : state.plan_review?.plan_id || state.plan_id, phase: 'completion' } };
    const hooks = { ...workflow.hooks, before_complete: [...new Set([...required, ...workflow.hooks.before_complete.filter((check) => check !== 'contract_docs' || finalImplementation)])] };
    const evidence_path = sessionOutputPath(workspace_root, `runtime/workflow-completion/${workflow.id}-${base_ref}.jsonl`);
    writer = await new JsonlEventWriter(evidence_path, { streamId: `${workflow.id}:${base_ref}` }).init();
    const verdict = await runLifecycleHook({ hook: 'before_complete', state: { ...state, workspace_root, contract_base_ref: base_ref }, registry: new LifecycleGateRegistry({ hooks }), eventWriter: writer, evidencePath: evidence_path });
    signal?.throwIfAborted();
    result = { workflow_id: workflow.id, completion_kind, state: verdict.status === 'pass' ? 'completed' : 'in-progress', session_directory: sessionDirectory(workspace_root), base_ref, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace_root, encoding: 'utf8' }).trim(), verdict, evidence_path };
    await writer.append('workflow_completion', result, { critical: true });
  } catch (error) { failure = error; }
  finally {
    try { await writer?.close(); } catch (error) { failure ||= error; }
    const retainForPlanning = !failure && !signal?.aborted && result?.state === 'completed' && result.completion_kind === 'spec_ready_for_planning';
    if (!retainForPlanning) {
      let cleanup;
      try { cleanup = await finishWorkflowWorktree({ workspace_root, worktree_id, outcome: signal?.aborted ? 'aborted' : !failure && result?.state === 'completed' ? 'completed' : 'failed' }); }
      catch (error) { cleanup = { state: 'failed', error: error.message, workspace_root }; }
      if (failure) failure.worktree_cleanup = cleanup;
      else {
        result.worktree_cleanup = cleanup;
        if (cleanup.state === 'failed') result.state = 'in-progress';
      }
    }
  }
  if (failure) throw failure;
  return result;
}
