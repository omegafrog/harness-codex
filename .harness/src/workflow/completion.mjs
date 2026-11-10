import { isAbsolute, join } from 'node:path';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadNamedWorkflow } from './loader.mjs';
import { LifecycleGateRegistry, runLifecycleHook } from '../gates/lifecycle.mjs';
import { JsonlEventWriter } from '../eval/journal.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
import { sessionDirectory, sessionOutputPath } from './session-output.mjs';
import { inspectWorkspace } from '../eval/workspace-preflight.mjs';
import { completeExecutionState } from './execution-state.mjs';
const execFileAsync = promisify(execFile);

// Two gate runs for the same workflow and start commit append to one journal. Started together they both wrote
// sequence 1, which the journal cannot repair, so only one run may hold the stream at a time.
export async function lockCompletionStream(evidencePath) {
  const lock = `${evidencePath}.lock`;
  await mkdir(join(lock, '..'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'pid'), String(process.pid));
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => ''));
      let alive = false;
      if (holder) { try { process.kill(holder, 0); alive = true; } catch (killError) { alive = killError.code === 'EPERM'; } }
      if (alive) throw new Error(`Another completion run for this workflow holds ${lock} (pid ${holder}); wait for it to finish`);
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`Cannot take the completion lock ${lock}`);
}

export function completionKindForWorkflow(workflowId) {
  return ({
    'spec-me': 'spec_ready_for_planning',
    'to-ticket': 'plan_set_ready_for_implementation',
    implement: 'plan_implemented',
    'implement-wrapper': 'feature_implemented',
    'frontend-design': 'feature_implemented',
  })[workflowId] || 'workflow_completed';
}

export async function completeWorkflow({ workflow_id, worktree_id = null, workspace_root, base_ref, state = {}, final_workflow = false, signal = null } = {}) {
  let writer, result, failure, unlock;
  try {
    signal?.throwIfAborted();
    if (!isAbsolute(workspace_root || '')) throw new Error('Absolute workspace_root is required');
    if (!/^[a-f0-9]{40}$/.test(base_ref || '')) throw new Error('Starting commit SHA is required');
    const workspace = await inspectWorkspace({ workspaceRoot: workspace_root, cwd: process.cwd() });
    if (!workspace.valid) throw new Error(`Workspace preflight failed: ${workspace.reason}`);
    let worktreeRecord = null;
    try { worktreeRecord = parseWorktreeRecord(await readFile(join(workspace_root, '.io/worktree.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (worktreeRecord || worktree_id) {
      if (!worktreeRecord || !workspace.is_linked_worktree || worktreeRecord.workspace !== workspace.workspace_root || worktreeRecord.state !== 'active' || worktreeRecord.worktree_id !== worktree_id) throw new Error('Canonical worktree ownership mismatch');
      const [common, gitDir, branch] = await Promise.all([
        execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: workspace_root, encoding: 'utf8' }),
        execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: workspace_root, encoding: 'utf8' }),
        execFileAsync('git', ['branch', '--show-current'], { cwd: workspace_root, encoding: 'utf8' }),
      ]);
      if (await realpath(common.stdout.trim()) !== worktreeRecord.common || (worktreeRecord.git_dir && await realpath(gitDir.stdout.trim()) !== worktreeRecord.git_dir) || branch.stdout.trim() !== worktreeRecord.branch) throw new Error('Canonical worktree identity mismatch');
    }
    const workflow = await loadNamedWorkflow(workflow_id, { root: workspace_root });
    const completion_kind = completionKindForWorkflow(workflow.id);
    const finalImplementation = completion_kind === 'feature_implemented';
    const required = ['tracker_sync', ...(finalImplementation ? ['contract_docs'] : []), ...(state.tests?.e2e_failures !== undefined ? ['tests'] : []), ...(workflow.id === 'spec-me' ? ['spec_reviews'] : []), ...(workflow.id === 'to-ticket' ? ['plan_review'] : []), ...(['implement', 'implement-wrapper'].includes(workflow.id) ? ['plan_review'] : [])];
    // The Architecture review of the worktree's plan set is already in the review history, so the gate reads it there
    // instead of needing the orchestrator to assemble a completion state file that names the ticket and the record.
    if (workflow.id === 'spec-me' && worktreeRecord?.plan_set_id && !state.spec_reviews) {
      const { inspectReviewHistory } = await import('./review-attempts.mjs');
      const architecture = (await inspectReviewHistory({ root: workspace_root, scope: `spec-${worktreeRecord.plan_set_id}-architecture` }).catch(() => ({}))).last_review;
      if (architecture) state = { ...state, ticket_id: state.ticket_id ?? worktreeRecord.plan_set_id, spec_reviews: { architecture } };
    }
    if (workflow.id === 'to-ticket') state = { ...state, plan_set_id: worktreeRecord?.plan_set_id, plans_index: { workspace_root, plan_set_id: worktreeRecord?.plan_set_id }, plan_review: { plan_set_id: worktreeRecord?.plan_set_id, phase: 'planning' } };
    if (['implement', 'implement-wrapper'].includes(workflow.id)) state = { ...state, ...(workflow.id === 'implement-wrapper' ? { plan_id: undefined } : {}), plan_review: { ...state.plan_review, plan_id: workflow.id === 'implement-wrapper' ? null : state.plan_review?.plan_id || state.plan_id, phase: 'completion' } };
    const hooks = { ...workflow.hooks, before_complete: [...new Set([...required, ...workflow.hooks.before_complete.filter((check) => check !== 'contract_docs' || finalImplementation)])] };
    const evidence_path = sessionOutputPath(workspace_root, `runtime/workflow-completion/${workflow.id}-${base_ref}.jsonl`);
    unlock = await lockCompletionStream(evidence_path);
    writer = await new JsonlEventWriter(evidence_path, { streamId: `${workflow.id}:${base_ref}` }).init();
    const verdict = await runLifecycleHook({ hook: 'before_complete', state: { ...state, workspace_root, contract_base_ref: base_ref }, registry: new LifecycleGateRegistry({ hooks }), eventWriter: writer, evidencePath: evidence_path });
    signal?.throwIfAborted();
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace_root, encoding: 'utf8' })).stdout.trim();
    result = { workflow_id: workflow.id, completion_kind, state: verdict.status === 'pass' ? 'completed' : 'in-progress', session_directory: sessionDirectory(workspace_root), base_ref, head, verdict, evidence_path, ...(worktreeRecord ? { worktree_retained: { state: 'preserved', workspace_root: worktreeRecord.workspace } } : {}) };
    await writer.append('workflow_completion', result, { critical: true });
    if (final_workflow && verdict.status === 'pass') await completeExecutionState({ root: workspace_root, session_directory: result.session_directory });
  } catch (error) { failure = error; }
  finally {
    try { await writer?.close(); } catch (error) { failure ||= error; }
    try { await unlock?.(); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return result;
}
