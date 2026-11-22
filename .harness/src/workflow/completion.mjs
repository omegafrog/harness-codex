import { isAbsolute, join } from 'node:path';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadNamedWorkflow } from './loader.mjs';
import { checkTrackerSync, LifecycleGateRegistry, runLifecycleHook } from '../gates/lifecycle.mjs';
import { JsonlEventWriter } from '../eval/journal.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';
import { sessionDirectory, sessionOutputPath } from './session-output.mjs';
import { inspectWorkspace } from '../eval/workspace-preflight.mjs';
import { completeExecutionState } from './execution-state.mjs';
import { DERIVED_STATE_KEYS, deriveApprovedTacticalE2E, deriveImplementationCompletion } from './implementation-completion.mjs';
import { deriveTacticalOutcome } from './tactical-tickets.mjs';
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
    'to-ticket': 'plan_set_ready_for_implementation',
    'tactical-to-code': 'tickets_implemented',
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
    // implement-wrapper completion is judged from canonical records only. A state file (or anything else the caller
    // supplies) cannot assert required_outcome, tests, reviews, retirement, evidence or the plan set, so those keys are
    // dropped before any check runs; the ones that were dropped are reported in the result.
    let derived = null;
    let ignoredStateKeys = [];
    if (workflow.id === 'implement-wrapper') {
      ignoredStateKeys = DERIVED_STATE_KEYS.filter((key) => state?.[key] !== undefined);
      state = Object.fromEntries(Object.entries(state || {}).filter(([key]) => !DERIVED_STATE_KEYS.includes(key)));
      const planSetId = worktreeRecord?.plan_set_id || null;
      state = { ...state, plan_set_id: planSetId, plan_review: { plan_set_id: planSetId, plan_id: null, phase: 'completion' } };
      derived = await deriveImplementationCompletion({ root: workspace_root, planSetId });
    }
    // The ticket-by-ticket outcome of tactical-to-code is read from the tracker and the recorded tactical-code runs only,
    // so a state file cannot claim it, and the published plan set must still be the reviewed one.
    let derivedOutcome = null;
    let tacticalE2E = null;
    if (workflow.id === 'tactical-to-code') {
      const canonicalKeys = ['required_outcome', 'plan_set_id', 'plans_index', 'plan_review', 'tests', 'tracker_sync'];
      ignoredStateKeys = canonicalKeys.filter((key) => state?.[key] !== undefined);
      state = Object.fromEntries(Object.entries(state || {}).filter(([key]) => !canonicalKeys.includes(key)));
      const context = { root: workspace_root, planSetId: worktreeRecord?.plan_set_id || null, session: sessionDirectory(workspace_root) };
      derivedOutcome = await deriveTacticalOutcome(context);
      tacticalE2E = await deriveApprovedTacticalE2E(context);
    }
    const required = ['tracker_sync', ...(finalImplementation ? ['contract_docs'] : []), ...(workflow.id === 'implement-wrapper' ? ['contract_review'] : []), ...(tacticalE2E || state.tests?.e2e_failures !== undefined ? ['tests'] : []), ...(['to-ticket', 'tactical-to-code'].includes(workflow.id) ? ['plan_review'] : []), ...(['implement', 'implement-wrapper'].includes(workflow.id) ? ['plan_review'] : [])];
    if (['to-ticket', 'tactical-to-code'].includes(workflow.id)) state = { ...state, plan_set_id: worktreeRecord?.plan_set_id, plans_index: { workspace_root, plan_set_id: worktreeRecord?.plan_set_id }, plan_review: { plan_set_id: worktreeRecord?.plan_set_id, phase: 'planning' } };
    if (workflow.id === 'implement') state = { ...state, plan_review: { plan_set_id: worktreeRecord?.plan_set_id, ...state.plan_review, plan_id: state.plan_review?.plan_id || state.plan_id, phase: 'completion' } };
    const hooks = { ...workflow.hooks, before_complete: [...new Set([...required, ...workflow.hooks.before_complete.filter((check) => check !== 'contract_docs' || finalImplementation)])] };
    const evidence_path = sessionOutputPath(workspace_root, `runtime/workflow-completion/${workflow.id}-${base_ref}.jsonl`);
    unlock = await lockCompletionStream(evidence_path);
    writer = await new JsonlEventWriter(evidence_path, { streamId: `${workflow.id}:${base_ref}` }).init();
    const registry = new LifecycleGateRegistry({ hooks });
    for (const [ruleId, verdictOfRecords] of Object.entries(derived?.checks || {})) registry.replace(ruleId, () => verdictOfRecords);
    if (derivedOutcome) registry.replace('required_outcome', () => derivedOutcome);
    if (derivedOutcome?.status === 'pass') registry.replace('tracker_sync', (gateState) => checkTrackerSync(gateState, { expected_status: 'completed' }));
    if (tacticalE2E) registry.replace('tests', () => tacticalE2E);
    const verdict = await runLifecycleHook({ hook: 'before_complete', state: { ...state, workspace_root, contract_base_ref: base_ref }, registry, eventWriter: writer, evidencePath: evidence_path });
    signal?.throwIfAborted();
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace_root, encoding: 'utf8' })).stdout.trim();
    result = { workflow_id: workflow.id, completion_kind, final_workflow, state: verdict.status === 'pass' ? 'completed' : 'in-progress', session_directory: sessionDirectory(workspace_root), base_ref, head, verdict, evidence_path, ...(ignoredStateKeys.length ? { ignored_state_keys: ignoredStateKeys } : {}), ...(worktreeRecord ? { worktree_retained: { state: 'preserved', workspace_root: worktreeRecord.workspace } } : {}) };
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
