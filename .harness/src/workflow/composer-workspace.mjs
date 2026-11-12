import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkflowWorktree, recordWorktreeOutcome, parseWorktreeRecord } from './worktrees.mjs';
import { readExecutionInput, resolveSkillSession, validateSkillInput, validateSkillReturn } from './skill-execution.mjs';
import { writeExecutionInput } from './execution-input.mjs';
import { recordExecutionState } from './execution-state.mjs';
import { assertSingleProvider, parseWorkflowBinding } from './providers/index.mjs';
import { parseYaml } from '../eval/yaml.mjs';

export async function createComposerWorkspace({ root, plan_set_id, request, execution_id, orchestrator_session_id = null, orchestrator_provider = null, workflow_binding = null }) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('Initial request is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(execution_id || '')) throw new Error('Execution ID is required');
  if (typeof plan_set_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan_set_id)) throw new Error('Explicit plan_set_id is required');
  if ((orchestrator_session_id !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(orchestrator_session_id)) || (orchestrator_provider !== null && !['codex', 'claude-code'].includes(orchestrator_provider)) || Boolean(orchestrator_session_id) !== Boolean(orchestrator_provider)) throw new Error('Invalid orchestrator provider session');
  // Refuse before creating a worktree when the request would run a different provider than setup chose.
  assertSingleProvider(parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')), workflow_binding ? parseWorkflowBinding(workflow_binding) : null);
  // Keep repeated feature requests readable without reusing tracker identity.
  const record = await createWorkflowWorktree({ workspace_root: root, feature_name: plan_set_id, workflow_binding });
  try {
    const storedInput = {
      schema_version: 1, execution_id, skill: 'workflow-compose', scope: request, input_refs: [],
      context: { worktree_ref: join(record.session_directory, 'worktree.json'), stage_id: 'workflow-compose', ...(orchestrator_session_id ? { orchestrator_session_id, orchestrator_provider } : {}) },
    };
    const input_path = await writeExecutionInput(record.workspace, storedInput, record.plan_set_id);
    const input = await readExecutionInput({ root: record.workspace, execution_id });
    await validateSkillInput({ root: record.workspace, input });
    await prepareComposerWorkspace({ root: record.workspace, session: record.session_directory, input, inputPath: input_path });
    const result_ref = `runtime/executions/${execution_id}/result.json`;
    const result = { schema_version: 1, execution_id, skill: 'workflow-compose', status: 'completed', code: 'OK', summary: '작업 workspace 준비 완료', artifacts: [], worktree_ref: storedInput.context.worktree_ref, questions: [] };
    const envelope = { schema_version: 1, execution_id, skill: 'workflow-compose', status: 'completed', code: 'OK', result_ref, result };
    await validateSkillReturn({ root: record.workspace, input, envelope });
    const directory = join(record.session_directory, 'runtime/executions', execution_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'return.json'), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await recordExecutionState({ root: record.workspace, input, binding: { model: null, reasoning_effort: null }, status: 'completed', code: 'OK', result_ref });
    return { ...record, execution_id, input_path, status: 'completed', code: 'OK', worktree_ref: storedInput.context.worktree_ref, result_ref };
  } catch (error) {
    try { await recordWorktreeOutcome({ workspace_root: record.workspace, repository_root: record.return_root, worktree_id: record.worktree_id, outcome: 'failed' }); }
    catch (recordError) { error.message += `; outcome recording failed: ${recordError.message}`; }
    error.message += `; worktree preserved: ${record.workspace}`;
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
