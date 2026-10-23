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
const WORKTREE_STATES = new Set(['allocating', 'active', 'archived', 'removed', 'cleanup-failed']);
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function durableJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}
function parseWorktreeRecord(text) {
  const record = JSON.parse(text);
  if (!record || record.schema_version !== 1 || !WORKTREE_ID.test(record.worktree_id || '') || !WORKTREE_STATES.has(record.state)
    || !['workspace', 'common', 'return_root', 'session_directory'].every((key) => isAbsolute(record[key] || ''))
    || typeof record.branch !== 'string' || !record.branch) throw new Error('Invalid worktree.json');
  return { ...record, source_workspace: record.source_workspace || record.return_root };
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
  return { ...store, directory, workspace, session_directory: directory, worktree_file: join(directory, 'worktree.json'), legacy_record: join(directory, 'receipt.json') };
}
async function readWorktreeRecord(place) {
  try { return parseWorktreeRecord(await readFile(place.worktree_file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const record = parseWorktreeRecord(await readFile(place.legacy_record, 'utf8'));
    await durableJson(place.worktree_file, record);
    await unlink(place.legacy_record);
    return record;
  }
}
async function writeWorktreeRecord(place, record) {
  parseWorktreeRecord(JSON.stringify(record));
  await durableJson(place.worktree_file, record);
  await unlink(place.legacy_record).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
async function readArchivedWorktree(recovery) {
  try { return parseWorktreeRecord(await readFile(join(recovery, 'worktree.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return parseWorktreeRecord(await readFile(join(recovery, 'receipt.json'), 'utf8'));
  }
}
async function describe(root) {
  const workspace = await realpath(root);
  if (await realpath(await git(root, ['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('Expected a Git worktree root');
  const common = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])));
  const git_dir = await realpath(resolve(root, await git(root, ['rev-parse', '--git-dir'])));
  if (git_dir === common) throw new Error('Primary worktree must never be removed');
  return { workspace, common, git_dir, branch: await git(root, ['branch', '--show-current']), head: await git(root, ['rev-parse', 'HEAD']) };
}

export async function reserveWorkflowWorktree({ workspace_root, repository_root, branch } = {}) {
  if (!branch) throw new Error('Expected branch is required');
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
  try { await lstat(place.workspace); throw new Error('Allocation path already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const old = await readWorktreeRecord(place); if (old.state !== 'removed') throw new Error('Allocation already has a pending owner'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source_workspace = await realpath(repository_root);
  const record = { schema_version: 1, worktree_id: randomUUID(), workspace: place.workspace, common: place.common, source_workspace, return_root: source_workspace, branch, state: 'allocating', session_directory: place.session_directory };
  await writeWorktreeRecord(place, record);
  return record;
  });
}

async function registerWorktree({ workspace_root, return_root } = {}) {
  const details = await describe(workspace_root);
  const target = await realpath(return_root || await primaryRoot(workspace_root));
  if (target === details.workspace || within(details.workspace, target)) throw new Error('Return workspace must survive cleanup');
  if (await realpath(resolve(target, await git(target, ['rev-parse', '--git-common-dir']))) !== details.common) throw new Error('Return workspace belongs to another repository');
  const place = await location(details.workspace, target);
  try {
    const existing = await readWorktreeRecord(place);
    if (existing.state === 'allocating' && existing.branch === details.branch && existing.common === details.common) {
      const record = { ...existing, ...details, state: 'active' };
      await writeWorktreeRecord(place, record); return record;
    }
    if (existing.state !== 'removed' && existing.git_dir !== details.git_dir) throw new Error('Worktree already belongs to another active owner');
    if (existing.state === 'active') return existing;
    if (existing.state !== 'removed') throw new Error('Finish the pending cleanup before registering another worktree');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: 1, worktree_id: randomUUID(), ...details, source_workspace: target, return_root: target, session_directory: place.session_directory, state: 'active', registered_at: new Date().toISOString() };
  await writeWorktreeRecord(place, record);
  return record;
}

export async function registerWorkflowWorktree(options = {}) {
  const place = await location(options.workspace_root, options.return_root || options.workspace_root);
  return withWorktreeLock(place, () => registerWorktree(options));
}

export async function createWorkflowWorktree({ workspace_root, branch = null, signal = null } = {}) {
  if (!isAbsolute(workspace_root || '')) throw new Error('Absolute source workspace is required');
  await storage(workspace_root);
  const sourceWorkspace = await realpath(workspace_root);
  const returnRoot = sourceWorkspace;
  const worktreeId = randomUUID();
  const workspace = join(dirname(returnRoot), '.harness-worktrees', basename(returnRoot), worktreeId);
  const sessionBranch = branch || `harness/worktree/${worktreeId}`;
  await git(workspace_root, ['check-ref-format', '--branch', sessionBranch]);
  if (!branch && await git(workspace_root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source workspace must be clean before creating a session branch');
  await mkdir(dirname(workspace), { recursive: true });
  const ownership = await reserveWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, branch: sessionBranch });
  try {
    if (branch) await git(workspace_root, ['worktree', 'add', '--', workspace, branch]);
    else await git(workspace_root, ['worktree', 'add', '-b', sessionBranch, '--', workspace, 'HEAD']);
    signal?.throwIfAborted();
    const record = await registerWorkflowWorktree({ workspace_root: workspace, return_root: returnRoot });
    return { ...record, source_workspace: sourceWorkspace };
  } catch (error) {
    error.worktree_cleanup = await finishWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, worktree_id: ownership.worktree_id, outcome: 'failed' });
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

async function finishRegisteredWorktree({ workspace_root, repository_root = workspace_root, worktree_id = null, outcome = 'aborted' } = {}) {
  if (!['completed', 'aborted', 'failed', 'handoff'].includes(outcome)) throw new Error('Invalid worktree exit outcome');
  const place = await location(workspace_root, repository_root);
  let record;
  try { record = await readWorktreeRecord(place); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'not-owned', workspace_root, reason: 'No worktree.json; workspace preserved' }; throw error; }
  if (record.workspace !== place.workspace || record.common !== place.common || (record.worktree_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.worktree_id)) || (worktree_id && record.worktree_id !== worktree_id)) throw new Error('Worktree ownership mismatch: worktree.json does not match this worktree');
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
        const archived = await readArchivedWorktree(recovery);
        if (archived.workspace !== place.workspace || archived.tree_sha256 !== await digestTree(join(recovery, 'files')) || await git(record.return_root, ['rev-parse', archived.recovery_ref]) !== archived.head) throw new Error('Recovery archive no longer verifies');
      }
      await writeWorktreeRecord(place, { ...record, state: 'removed' });
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
    await durableJson(join(recovery, 'worktree.json'), snapshot);
    await writeWorktreeRecord(place, snapshot);
    await git(returnRoot, ['worktree', 'remove', '--force', '--', place.workspace]);
    const listed = await git(returnRoot, ['worktree', 'list', '--porcelain', '-z']);
    if (listed.split('\0').includes(`worktree ${place.workspace}`)) throw new Error('Worktree is still registered after removal');
    await writeWorktreeRecord(place, { ...snapshot, state: 'removed', removed_at: new Date().toISOString() });
    return { state: 'removed', workspace_root, return_root: returnRoot, recovery_path: recovery, recovery_ref, branch: current.branch, head: current.head };
  } catch (error) {
    await writeWorktreeRecord(place, { ...record, state: 'cleanup-failed', recovery_path: recovery, error: error.message, outcome });
    return { state: 'failed', workspace_root, return_root: record.return_root, recovery_path: recovery, error: error.message, retry: 'Stop owned writers and rerun finish from return_root with --repository' };
  }
}

async function withWorktreeLock(place, action) {
  const lockPath = `${place.worktree_file}.lock`;
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
  const records = await Promise.all((await readdir(directory)).filter((name) => /^[a-f0-9]{64}$/.test(name)).map(async (name) => {
    const place = { worktree_file: join(directory, name, 'worktree.json'), legacy_record: join(directory, name, 'receipt.json') };
    try { return parseWorktreeRecord(await readFile(place.worktree_file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let legacy;
    try { legacy = JSON.parse(await readFile(place.legacy_record, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!legacy?.worktree_id) return null;
    const record = parseWorktreeRecord(JSON.stringify(legacy));
    await durableJson(place.worktree_file, record);
    await unlink(place.legacy_record);
    return record;
  }));
  return records.filter((record) => record && record.state !== 'removed');
}
