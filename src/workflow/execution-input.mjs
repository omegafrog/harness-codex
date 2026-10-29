import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function executionInputPath(planSetId, skill, executionId) {
  if (![planSetId, skill, executionId].every((value) => typeof value === 'string' && ID.test(value))) throw new Error('Invalid execution input identity');
  return `.io/${planSetId}/${skill}/${executionId}/input.json`;
}

export async function writeExecutionInput(root, input, planSetId) {
  const path = executionInputPath(planSetId, input.skill, input.execution_id);
  await assertWorkspaceTarget(root, path);
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await assertWorkspaceTarget(root, path);
  await writeFile(join(root, path), JSON.stringify(input, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

export async function findExecutionInput(root, executionId) {
  if (!ID.test(executionId || '')) throw new Error('Invalid execution ID');
  const listing = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' });
  const primary = listing.split('\0').find((item) => item.startsWith('worktree '))?.slice(9);
  const matches = [];
  for (const workspace of new Set([resolve(root), ...(primary ? [resolve(primary)] : [])])) {
    const directory = join(workspace, '.io');
    const plans = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const plan of plans.filter((entry) => entry.isDirectory() && ID.test(entry.name))) {
      const skills = await readdir(join(directory, plan.name), { withFileTypes: true });
      for (const skill of skills.filter((entry) => entry.isDirectory() && ID.test(entry.name))) {
        const path = executionInputPath(plan.name, skill.name, executionId);
        await assertWorkspaceTarget(workspace, path);
        const info = await lstat(join(workspace, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) throw new Error('Unsafe execution input');
        if (info) matches.push({ workspace, path });
      }
    }
  }
  if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Duplicate execution inputs' : 'Execution input not found'), { code: matches.length ? 'EEXIST' : 'ENOENT' });
  const match = matches[0];
  const input = JSON.parse(await readFile(join(match.workspace, match.path), 'utf8'));
  if (input.execution_id !== executionId || match.path.split('/')[2] !== input.skill) throw new Error('Execution input identity mismatch');
  return { ...match, input };
}
