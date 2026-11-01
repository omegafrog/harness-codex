import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseWorktreeRecord } from './worktrees.mjs';
import { resolveSkillSession } from './skill-execution.mjs';

export async function cliSession(root, worktreeRef) {
  if (!worktreeRef) return resolveSkillSession(root);
  if (!isAbsolute(worktreeRef)) throw new Error('Absolute worktree-ref is required');
  const info = await lstat(worktreeRef);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Worktree record must be a regular file');
  const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
  const session = await resolveSkillSession(root, record.session_directory);
  if (record.state !== 'active' || worktreeRef !== join(session, 'worktree.json') || await realpath(record.workspace) !== await realpath(root)) throw new Error('Worktree record does not match the active workspace');
  return session;
}
