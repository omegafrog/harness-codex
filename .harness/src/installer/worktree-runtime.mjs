import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readHarnessLock } from './lock.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { protectLocalInstallArtifacts } from './local-exclude.mjs';
import { syncOrchestratorHook } from './orchestrator-hook.mjs';

// Linked worktrees inherit tracked application files, not ignored installed assets.
export async function provisionWorktreeRuntime(sourceRoot, targetRoot) {
  const lockPath = '.codex/harness-lock.json';
  let lock;
  try { lock = await readHarnessLock(join(sourceRoot, lockPath)); }
  catch (error) { if (error.code !== 'ENOENT' && error.cause?.code !== 'ENOENT') throw error; }
  const copy = async (path, expected = null) => {
    await assertWorkspaceTarget(targetRoot, path);
    const source = join(sourceRoot, path), target = join(targetRoot, path);
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe worktree asset: ${path}`);
      // Branch-owned files and settings take precedence over the original workspace.
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await assertWorkspaceTarget(sourceRoot, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe installed Harness asset: ${path}`);
    const content = await readFile(source);
    if (expected && createHash('sha256').update(content).digest('hex') !== expected) throw new Error(`Installed Harness asset drift: ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: info.mode & 0o777 });
  };
  if (lock) {
    await protectLocalInstallArtifacts(targetRoot, sourceRoot);
    for (const [path, entry] of Object.entries(lock.files)) await copy(path, entry.installed_sha256);
    await copy(lockPath);
  }
  for (const path of ['.codex/harness.yaml', '.codex/context-budget.json', 'docs/agents/EXEC.md', 'docs/agents/execution.json']) {
    try { await copy(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (lock) await syncOrchestratorHook(targetRoot);
}
