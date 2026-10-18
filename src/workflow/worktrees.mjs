import { sessionDirectory, sessionOutputPath } from './session-output.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, readdir, realpath, rename, writeFile, open, unlink, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';

const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
const primaryRoot = async (root) => (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0').find((line) => line.startsWith('worktree '))?.slice(9);
const within = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
async function durableJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}
async function storage(repository) {
  const common = await realpath(resolve(repository, await git(repository, ['rev-parse', '--git-common-dir'])));
  const directory = join(common, 'harness-workflows', 'sessions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe worktree recovery directory');
  await chmod(directory, 0o700);
  return { common, directory };
}
async function location(root, repository = root) {
  if (!isAbsolute(root || '') || !isAbsolute(repository || '')) throw new Error('Absolute workspace and repository roots are required');
  const store = await storage(repository);
  const workspace = resolve(root);
  const directory = sessionDirectory(workspace, { repositoryRoot: repository });
  return { ...store, directory, workspace, session_directory: directory, receipt: join(directory, 'receipt.json') };
}
async function describe(root) {
  const workspace = await realpath(root);
  if (await realpath(await git(root, ['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('Expected a Git worktree root');
  const common = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])));
  const git_dir = await realpath(resolve(root, await git(root, ['rev-parse', '--git-dir'])));
  if (git_dir === common) throw new Error('Primary worktree must never be removed');
  return { workspace, common, git_dir, branch: await git(root, ['branch', '--show-current']), head: await git(root, ['rev-parse', 'HEAD']) };
}

export async function reserveWorkflowWorktree({ workspace_root, repository_root, workflow_id, branch } = {}) {
  if (!safeId(workflow_id) || !branch) throw new Error('Workflow and expected branch are required');
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
  try { await lstat(place.workspace); throw new Error('Allocation path already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const old = JSON.parse(await readFile(place.receipt, 'utf8')); if (old.state !== 'removed') throw new Error('Allocation already has a pending owner'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await durableJson(place.receipt, { schema_version: 1, workspace: place.workspace, common: place.common, return_root: await realpath(repository_root), workflow_id, branch, state: 'allocating', session_directory: place.session_directory });
  });
}

async function registerWorktree({ workspace_root, workflow_id, return_root } = {}) {
  if (!safeId(workflow_id)) throw new Error('Safe workflow ID is required');
  const details = await describe(workspace_root);
  const target = await realpath(return_root || await primaryRoot(workspace_root));
  if (target === details.workspace || within(details.workspace, target)) throw new Error('Return workspace must survive cleanup');
  if (await realpath(resolve(target, await git(target, ['rev-parse', '--git-common-dir']))) !== details.common) throw new Error('Return workspace belongs to another repository');
  const place = await location(details.workspace, target);
  try {
    const existing = JSON.parse(await readFile(place.receipt, 'utf8'));
    if (existing.state === 'allocating' && existing.branch === details.branch && existing.common === details.common && existing.workflow_id === workflow_id) {
      const record = { ...existing, ...details, state: 'active' };
      await durableJson(place.receipt, record); return record;
    }
    if (existing.state !== 'removed' && (existing.git_dir !== details.git_dir || existing.workflow_id !== workflow_id)) throw new Error('Worktree already belongs to another active workflow');
    if (existing.state === 'active') return existing;
    if (existing.state !== 'removed') throw new Error('Finish the pending cleanup before registering another workflow');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: 1, ...details, workflow_id, return_root: target, session_directory: place.session_directory, state: 'active', registered_at: new Date().toISOString() };
  await durableJson(place.receipt, record);
  return record;
}

export async function registerWorkflowWorktree(options = {}) {
  const place = await location(options.workspace_root, options.return_root || options.workspace_root);
  return withWorktreeLock(place, () => registerWorktree(options));
}

export async function createWorkflowWorktree({ workspace_root, workflow_id, branch = null, signal = null } = {}) {
  if (!isAbsolute(workspace_root || '') || !safeId(workflow_id)) throw new Error('Absolute source workspace and workflow ID are required');
  await storage(workspace_root);
  const returnRoot = await primaryRoot(workspace_root);
  if (!returnRoot) throw new Error('Primary worktree is unavailable');
  const id = randomUUID();
  const workspace = join(dirname(returnRoot), '.harness-worktrees', basename(returnRoot), id);
  const sessionBranch = branch || `harness/${workflow_id}/${id}`;
  await git(workspace_root, ['check-ref-format', '--branch', sessionBranch]);
  if (!branch && await git(workspace_root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source workspace must be clean before creating a session branch');
  await mkdir(dirname(workspace), { recursive: true });
  await reserveWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, workflow_id, branch: sessionBranch });
  try {
    if (branch) await git(workspace_root, ['worktree', 'add', '--', workspace, branch]);
    else await git(workspace_root, ['worktree', 'add', '-b', sessionBranch, '--', workspace, 'HEAD']);
    signal?.throwIfAborted();
    return await registerWorkflowWorktree({ workspace_root: workspace, workflow_id, return_root: returnRoot });
  } catch (error) {
    error.worktree_cleanup = await finishWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, workflow_id, outcome: 'failed' });
    error.message += `; allocation cleanup=${error.worktree_cleanup.state}; workspace=${workspace}`;
    throw error;
  }
}

async function digestTree(root) {
  const hash = createHash('sha256');
  async function walk(path, name) {
    const info = await lstat(path);
    hash.update(`${name}\0${info.mode}\0`);
    if (info.isSymbolicLink()) hash.update(await readlink(path));
    else if (info.isFile()) hash.update(await readFile(path));
    else if (info.isDirectory()) for (const child of (await readdir(path)).sort()) {
      if (!name && child === '.git') continue;
      await walk(join(path, child), name ? `${name}/${child}` : child);
    }
    else throw new Error(`Cannot safely archive special file: ${name}`);
  }
  // Directory root permissions are intentionally private in the archive.
  for (const child of (await readdir(root)).sort()) if (child !== '.git') await walk(join(root, child), child);
  return hash.digest('hex');
}

async function finishRegisteredWorktree({ workspace_root, repository_root = workspace_root, workflow_id = null, outcome = 'aborted' } = {}) {
  if (!['completed', 'aborted', 'failed', 'handoff'].includes(outcome)) throw new Error('Invalid workflow exit outcome');
  const place = await location(workspace_root, repository_root);
  let record;
  try { record = JSON.parse(await readFile(place.receipt, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'not-owned', workspace_root, reason: 'No Harness ownership receipt; workspace preserved' }; throw error; }
  if (record.workspace !== place.workspace || record.common !== place.common || !safeId(record.workflow_id) || (workflow_id && record.workflow_id !== workflow_id)) throw new Error('Worktree ownership mismatch');
  if (record.state === 'removed') {
    try { await lstat(place.workspace); throw new Error('Workspace path was reused; register the new worktree explicitly'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { state: 'removed', workspace_root, return_root: record.return_root, recovery_path: record.recovery_path, already_removed: true };
  }
  let recovery = record.recovery_path || null;
  try {
    try { await lstat(place.workspace); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const listed = await git(record.return_root, ['worktree', 'list', '--porcelain', '-z']);
      if (listed.split('\0').includes(`worktree ${place.workspace}`)) throw new Error('Missing path remains registered in Git');
      if (record.state !== 'allocating') {
        const archived = JSON.parse(await readFile(join(recovery, 'receipt.json'), 'utf8'));
        if (archived.workspace !== place.workspace || archived.tree_sha256 !== await digestTree(join(recovery, 'files')) || await git(record.return_root, ['rev-parse', archived.recovery_ref]) !== archived.head) throw new Error('Recovery archive no longer verifies');
      }
      await durableJson(place.receipt, { ...record, state: 'removed' });
      return { state: 'removed', workspace_root, return_root: record.return_root, recovery_path: recovery, already_removed: true };
    }
    const current = await describe(place.workspace);
    if (record.state === 'allocating' && current.branch === record.branch && current.common === record.common) record = { ...record, ...current, state: 'active' };
    if (current.git_dir !== record.git_dir || current.common !== record.common || current.branch !== record.branch) throw new Error('Worktree identity/branch changed; cleanup refused');
    const returnRoot = await realpath(record.return_root);
    if (within(place.workspace, returnRoot) || await realpath(resolve(returnRoot, await git(returnRoot, ['rev-parse', '--git-common-dir']))) !== record.common) throw new Error('Return workspace no longer matches repository');
    recovery = sessionOutputPath(place.workspace, `recovery/${randomUUID()}`, { repositoryRoot: record.return_root });
    await mkdir(recovery, { mode: 0o700 });
    const files = join(recovery, 'files');
    const before = await digestTree(place.workspace);
    await cp(place.workspace, files, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (path) => path !== join(place.workspace, '.git') });
    const index = await readFile(join(current.git_dir, 'index'));
    await writeFile(join(recovery, 'index'), index, { mode: 0o600 });
    if (before !== await digestTree(place.workspace) || before !== await digestTree(files) || current.head !== await git(place.workspace, ['rev-parse', 'HEAD']) || !index.equals(await readFile(join(current.git_dir, 'index')))) throw new Error('Workspace changed during archive; stop writers and retry');
    const staged = await git(place.workspace, ['ls-files', '--stage', '-z']);
    const blobs = [...new Set(staged.split('\0').flatMap((line) => { const m = line.match(/^(?:100644|100755|120000) ([a-f0-9]+) [0-3]\t/); return m ? [m[1]] : []; }))];
    const treeCommand = exec('git', ['mktree'], { cwd: record.return_root, encoding: 'utf8' });
    treeCommand.child.stdin.end(blobs.map((oid, i) => `100644 blob ${oid}\tindex-${i}\n`).join(''));
    const staged_ref = `refs/harness/recovery/index-${randomUUID()}`;
    await git(record.return_root, ['update-ref', staged_ref, (await treeCommand).stdout.trim()]);
    const recovery_ref = `refs/harness/recovery/${randomUUID()}`;
    await git(returnRoot, ['update-ref', recovery_ref, current.head]);
    const snapshot = { ...record, outcome, head: current.head, tree_sha256: before, staged_ref, recovery_ref, recovery_path: recovery, archived_at: new Date().toISOString(), state: 'archived' };
    await durableJson(join(recovery, 'receipt.json'), snapshot);
    await durableJson(place.receipt, snapshot);
    await git(returnRoot, ['worktree', 'remove', '--force', '--', place.workspace]);
    const listed = await git(returnRoot, ['worktree', 'list', '--porcelain', '-z']);
    if (listed.split('\0').includes(`worktree ${place.workspace}`)) throw new Error('Worktree is still registered after removal');
    await durableJson(place.receipt, { ...snapshot, state: 'removed', removed_at: new Date().toISOString() });
    return { state: 'removed', workspace_root, return_root: returnRoot, recovery_path: recovery, recovery_ref, branch: current.branch, head: current.head };
  } catch (error) {
    await durableJson(place.receipt, { ...record, state: 'cleanup-failed', recovery_path: recovery, error: error.message, outcome });
    return { state: 'failed', workspace_root, return_root: record.return_root, recovery_path: recovery, error: error.message, retry: 'Stop owned writers and rerun finish from return_root with --repository' };
  }
}

async function withWorktreeLock(place, action) {
  const lockPath = `${place.receipt}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(owner.pid, 0); throw new Error('Cleanup is already running; retry after it exits'); }
    catch (ownerError) { if (ownerError.code !== 'ESRCH') throw ownerError; }
    await unlink(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

export async function finishWorkflowWorktree(options = {}) {
  const place = await location(options.workspace_root, options.repository_root || options.workspace_root);
  return withWorktreeLock(place, () => finishRegisteredWorktree(options));
}

export async function listWorkflowWorktrees({ workspace_root } = {}) {
  const { directory } = await storage(workspace_root);
  return Promise.all((await readdir(directory)).filter((name) => /^[a-f0-9]{64}$/.test(name)).map(async (name) => {
    try { return JSON.parse(await readFile(join(directory, name, 'receipt.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })).then((records) => records.filter((record) => record && record.state !== 'removed'));
}
