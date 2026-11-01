import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

function directory(path, create = true) {
  if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  let info;
  try { info = lstatSync(path); } catch (error) { if (!create && error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error(`Session output directory must not be a symlink: ${path}`);
  if (!info.isDirectory()) throw Object.assign(new Error(`Session output parent must be a directory: ${path}`), { code: 'ENOTDIR' });
}
export function sessionDirectory(workspaceRoot, { repositoryRoot = workspaceRoot, create = true } = {}) {
  if (!isAbsolute(workspaceRoot || '') || !isAbsolute(repositoryRoot || '')) throw new Error('Absolute workspace/repository roots are required');
  const path = join(resolve(workspaceRoot), '.io');
  directory(path, create);
  if (create) chmodSync(path, 0o700);
  return path;
}
export function sessionOutputPath(workspaceRoot, output, options = {}) {
  if (typeof output !== 'string' || !output || isAbsolute(output) || win32.isAbsolute(output) || output.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('Session output must be a relative path without traversal');
  const root = sessionDirectory(workspaceRoot, options), target = resolve(root, output);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Output escapes the session directory');
  let parent = root;
  for (const part of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) { parent = join(parent, part); directory(parent, options.create !== false); }
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink > 1)) throw new Error('Session output must not target a symlink or shared hardlink or special file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
