import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { inspectContracts } from '../contracts/contracts.mjs';
import { readExecutionManifest } from './execution.mjs';

// This checks preparation without launching commands or inventing consumer business contracts.
export async function inspectProjectReadiness({ workspace_root } = {}) {
  let execution;
  try {
    if (!isAbsolute(workspace_root || '')) throw new Error('Absolute workspace_root is required');
    await assertWorkspaceTarget(workspace_root, 'docs/agents/EXEC.md');
    if (!(await readFile(join(workspace_root, 'docs/agents/EXEC.md'), 'utf8')).trim()) throw new Error('EXEC.md is empty');
    await readExecutionManifest(workspace_root);
    execution = { status: 'pass', reason: 'execution_contract_valid', violations: [] };
  } catch (error) {
    execution = { status: 'fail', reason: 'execution_contract_invalid', violations: [error.message] };
  }
  const contracts = await inspectContracts({ workspace_root });
  const next_steps = [];
  if (execution.status !== 'pass') next_steps.push('setup: inspect actual entrypoints/config/CI/infrastructure and prepare docs/agents/EXEC.md + execution.json; preserve existing profiles');
  if (contracts.status !== 'pass') next_steps.push('sync-contracts: reconcile actual source/specs/model and create or repair the complete docs/contracts bundle, diagrams and sealed manifest');
  return { status: next_steps.length ? 'blocked' : 'pass', reason: next_steps.length ? 'project_preparation_required' : 'project_ready', execution, contracts, next_steps };
}
