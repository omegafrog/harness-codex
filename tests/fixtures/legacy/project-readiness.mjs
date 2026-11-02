import { isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

export async function inspectProjectReadiness({ workspace_root } = {}) {
  const paths = ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html'];
  const violations = [];
  if (!isAbsolute(workspace_root || '')) violations.push('Absolute workspace_root is required');
  else for (const path of paths) {
    try { await assertWorkspaceTarget(workspace_root, path); if (!(await stat(join(workspace_root, path))).isFile()) throw new Error('Not a file'); }
    catch { violations.push(`Missing or invalid file: ${path}`); }
  }
  return { status: violations.length ? 'blocked' : 'pass', reason: violations.length ? 'project_preparation_required' : 'project_ready', violations };
}
