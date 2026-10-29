import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindWorkflowPlanSetId, createWorkflowWorktree, parseWorktreeRecord, planSetSlug } from './worktrees.mjs';
import { resolveSkillSession, readSkillSessionJson, readExecutionInput } from './skill-execution.mjs';

// Only the deterministic worktree lifecycle runs outside the model sandbox.
export async function prepareComposerWorkspace({ root, session, input, inputPath }) {
  const pathPlanSetId = inputPath.split('/')[1];
  const requestedPlanSetId = input.context?.plan_set_id || (input.context?.feature_name ? planSetSlug(input.context.feature_name) : null);
  if (requestedPlanSetId && requestedPlanSetId !== pathPlanSetId) throw new Error('Compose input path does not match plan_set_id');
  let reference = input.context?.worktree_ref;
  if (!reference) {
    let state;
    try { state = (await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/workflow.json' })).state; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state) {
      try { state = await readSkillSessionJson({ root, session_directory: session, path: 'runtime/orchestrator/state.json' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const current = state?.stages?.['workflow-compose'];
    const previous = current?.execution_id === input.execution_id ? current.attempts?.at(-1) : current;
    if (previous?.execution_id && previous.execution_id !== input.execution_id) {
      const prior = await readExecutionInput({ root, execution_id: previous.execution_id });
      reference = prior.context?.worktree_ref;
    }
  }
  let record;
  if (reference) {
    const directory = reference.slice(0, -'/worktree.json'.length);
    if (!reference.endsWith('/worktree.json')) throw new Error('Invalid canonical worktree reference');
    await resolveSkillSession(root, directory);
    record = parseWorktreeRecord(await readFile(reference, 'utf8'));
    if (record.state !== 'active' || record.session_directory !== directory) throw new Error('Worktree requires lifecycle recovery');
    if (input.context?.plan_set_id && record.plan_set_id && input.context.plan_set_id !== record.plan_set_id) throw new Error('Workflow plan_set_id conflicts with the active worktree');
    if (!record.plan_set_id) record = await bindWorkflowPlanSetId({ workspace_root: record.workspace, repository_root: record.return_root, ...(input.context?.plan_set_id ? { plan_set_id: input.context.plan_set_id } : { feature_name: input.context?.feature_name }) });
  } else {
    if (!input.context?.plan_set_id && !input.context?.feature_name) throw new Error('A feature_name derived from the initial request is required for a new worktree');
    record = await createWorkflowWorktree({ workspace_root: root, return_root: input.shared_guidance_root, ...(input.context?.plan_set_id ? { plan_set_id: input.context.plan_set_id } : { feature_name: input.context.feature_name }) });
  }
  if (record.plan_set_id) {
    if (record.plan_set_id !== pathPlanSetId) throw new Error('Compose input path does not match the active worktree plan_set_id');
    if (input.context?.plan_set_id && input.context.plan_set_id !== record.plan_set_id) throw new Error('Workflow plan_set_id conflicts with the prepared worktree');
    input.context = { ...input.context, plan_set_id: record.plan_set_id };
  }
  input.context = { ...input.context, worktree_ref: join(record.session_directory, 'worktree.json') };
  await writeFile(join(root, inputPath), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
  return record;
}
