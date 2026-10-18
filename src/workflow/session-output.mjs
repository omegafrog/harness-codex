import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

function directory(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`Session output directory must not be a symlink: ${path}`);
  if (!info.isDirectory()) throw Object.assign(new Error(`Session output parent must be a directory: ${path}`), { code: 'ENOTDIR' });
}
export function sessionDirectory(workspaceRoot, { repositoryRoot = workspaceRoot } = {}) {
  if (!isAbsolute(workspaceRoot || '') || !isAbsolute(repositoryRoot || '')) throw new Error('Absolute workspace/repository roots are required');
  const repository = realpathSync(repositoryRoot);
  let anchor;
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    anchor = realpathSync(resolve(repository, common));
  } catch (error) {
    if (!/not a git repository/.test(error.stderr?.toString() || '')) throw error;
    anchor = repository;
  }
  const workspace = resolve(workspaceRoot);
  const id = createHash('sha256').update(workspace).digest('hex');
  const parts = anchor === repository ? ['.codex', 'sessions', id] : ['harness-workflows', 'sessions', id];
  let path = anchor;
  for (const part of parts) { path = join(path, part); directory(path); }
  chmodSync(path, 0o700);
  return path;
}
export function sessionOutputPath(workspaceRoot, output, options = {}) {
  if (typeof output !== 'string' || !output || isAbsolute(output) || win32.isAbsolute(output) || output.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('Session output must be a relative path without traversal');
  const root = sessionDirectory(workspaceRoot, options), target = resolve(root, output);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Output escapes the session directory');
  let parent = root;
  for (const part of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) { parent = join(parent, part); directory(parent); }
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink > 1)) throw new Error('Session output must not target a symlink or shared hardlink or special file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
