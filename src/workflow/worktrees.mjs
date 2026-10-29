import { provisionWorktreeRuntime } from '../installer/worktree-runtime.mjs';
import { sessionDirectory } from './session-output.mjs';
import { WORKTREE_STAGE } from './worktree-stages.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, open, unlink, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';

const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
const primaryRoot = async (root) => (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0').find((line) => line.startsWith('worktree '))?.slice(9);
const within = (root, path) => { const rel = relative(root, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
const WORKTREE_STATES = new Set(['allocating', 'active', 'archived', 'removed', 'cleanup-failed']);
const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_SET_SLUG_LENGTH = 64;
function validatePlanSetId(value) {
  if (value !== undefined && (typeof value !== 'string' || !PLAN_SET_ID.test(value))) throw new Error('Invalid plan_set_id');
}
export function planSetSlug(featureName) {
  if (typeof featureName !== 'string' || !featureName.trim()) throw new Error('feature_name is required to generate plan_set_id');
  const slug = featureName.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, PLAN_SET_SLUG_LENGTH).replace(/-+$/g, '');
  if (!slug) throw new Error('feature_name must contain an English letter or digit so it can form a readable plan_set_id');
  return slug;
}
async function durableJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}
export function parseWorktreeRecord(text) {
  const record = JSON.parse(text);
  if (!record || record.schema_version !== 1 || !WORKTREE_ID.test(record.worktree_id || '') || !WORKTREE_STATES.has(record.state)
    || !['workspace', 'common', 'return_root', 'session_directory'].every((key) => isAbsolute(record[key] || ''))
    || typeof record.branch !== 'string' || !record.branch) throw new Error('Invalid worktree.json');
  validatePlanSetId(record.plan_set_id);
  if (record.current_stage !== undefined && !Object.values(WORKTREE_STAGE).includes(record.current_stage)) throw new Error('Invalid worktree current_stage');
  if (record.agent_sessions !== undefined) {
    if (!record.agent_sessions || typeof record.agent_sessions !== 'object' || Array.isArray(record.agent_sessions)) throw new Error('Invalid worktree agent_sessions');
    for (const [key, entry] of Object.entries(record.agent_sessions)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(key) || !entry || typeof entry !== 'object' || !WORKTREE_ID.test(entry.session_id || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.execution_id || '')) throw new Error('Invalid worktree agent session');
    }
  }
  return { ...record, source_workspace: record.source_workspace || record.return_root };
}
async function storage(repository) {
  const common = await realpath(resolve(repository, await git(repository, ['rev-parse', '--git-common-dir'])));
  const directory = join(common, 'harness-reservations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { common, directory };
}
async function location(root, repository = root) {
  if (!isAbsolute(root || '') || !isAbsolute(repository || '')) throw new Error('Absolute workspace and repository roots are required');
  const store = await storage(repository);
  const workspace = resolve(root);
  const directory = join(workspace, '.io');
  const reservation = join(store.directory, `${createHash('sha256').update(workspace).digest('hex')}.json`);
  const present = await lstat(workspace).then((info) => info.isDirectory(), (error) => { if (error.code === 'ENOENT') return false; throw error; });
  const recordExists = present && await lstat(join(directory, 'worktree.json')).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (present && !recordExists) {
    const reserved = await lstat(reservation).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
    if (reserved) return { ...store, directory, workspace, session_directory: directory, worktree_file: reservation, legacy_record: reservation };
  }
  if (present) await mkdir(directory, { recursive: true, mode: 0o700 });
  return { ...store, directory, workspace, session_directory: directory, worktree_file: present ? join(directory, 'worktree.json') : reservation, legacy_record: present ? join(directory, 'receipt.json') : reservation };
}
async function readWorktreeRecord(place) {
  try { return parseWorktreeRecord(await readFile(place.worktree_file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (place.legacy_record === place.worktree_file) throw error;
    const record = parseWorktreeRecord(await readFile(place.legacy_record, 'utf8'));
    await durableJson(place.worktree_file, record);
    await unlink(place.legacy_record);
    return record;
  }
}
async function writeWorktreeRecord(place, record) {
  parseWorktreeRecord(JSON.stringify(record));
  await durableJson(place.worktree_file, record);
  if (place.legacy_record !== place.worktree_file) await unlink(place.legacy_record).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
async function describe(root) {
  const workspace = await realpath(root);
  if (await realpath(await git(root, ['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('Expected a Git worktree root');
  const common = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])));
  const git_dir = await realpath(resolve(root, await git(root, ['rev-parse', '--git-dir'])));
  if (git_dir === common) throw new Error('Primary worktree must never be removed');
  return { workspace, common, git_dir, branch: await git(root, ['branch', '--show-current']), head: await git(root, ['rev-parse', 'HEAD']) };
}

export async function reserveWorkflowWorktree({ workspace_root, repository_root, branch, plan_set_id } = {}) {
  if (!branch) throw new Error('Expected branch is required');
  validatePlanSetId(plan_set_id);
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
  try { await lstat(place.workspace); throw new Error('Allocation path already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const old = await readWorktreeRecord(place); if (old.state !== 'removed') throw new Error('Allocation already has a pending owner'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source_workspace = await realpath(repository_root);
  const record = { schema_version: 1, worktree_id: randomUUID(), workspace: place.workspace, common: place.common, source_workspace, return_root: source_workspace, branch, ...(plan_set_id ? { plan_set_id } : {}), state: 'allocating', current_stage: WORKTREE_STAGE.WORKFLOW_COMPOSE, session_directory: place.session_directory };
  await writeWorktreeRecord(place, record);
  return record;
  });
}

async function registerWorktree({ workspace_root, return_root, plan_set_id } = {}) {
  validatePlanSetId(plan_set_id);
  const details = await describe(workspace_root);
  const target = await realpath(return_root || await primaryRoot(workspace_root));
  if (target === details.workspace || within(details.workspace, target)) throw new Error('Return workspace must survive cleanup');
  if (await realpath(resolve(target, await git(target, ['rev-parse', '--git-common-dir']))) !== details.common) throw new Error('Return workspace belongs to another repository');
  const place = await location(details.workspace, target);
  try {
    const existing = await readWorktreeRecord(place);
    if (plan_set_id && existing.plan_set_id && existing.plan_set_id !== plan_set_id) throw new Error('Worktree plan_set_id mismatch');
    if (existing.state === 'allocating' && existing.branch === details.branch && existing.common === details.common) {
      const record = { ...existing, ...details, ...(existing.plan_set_id || plan_set_id ? { plan_set_id: existing.plan_set_id || plan_set_id } : {}), state: 'active' };
      await mkdir(place.directory, { recursive: true, mode: 0o700 });
      await durableJson(join(place.directory, 'worktree.json'), record);
      if (place.worktree_file !== join(place.directory, 'worktree.json')) await unlink(place.worktree_file);
      return record;
    }
    if (existing.state !== 'removed' && existing.git_dir !== details.git_dir) throw new Error('Worktree already belongs to another active owner');
    if (existing.state === 'active') {
      if (plan_set_id && !existing.plan_set_id) {
        const record = { ...existing, plan_set_id };
        await writeWorktreeRecord(place, record);
        return record;
      }
      return existing;
    }
    if (existing.state !== 'removed') throw new Error('Finish the pending cleanup before registering another worktree');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: 1, worktree_id: randomUUID(), ...details, source_workspace: target, return_root: target, session_directory: place.session_directory, ...(plan_set_id ? { plan_set_id } : {}), state: 'active', current_stage: WORKTREE_STAGE.WORKFLOW_COMPOSE, registered_at: new Date().toISOString() };
  await writeWorktreeRecord(place, record);
  return record;
}

export async function registerWorkflowWorktree(options = {}) {
  const place = await location(options.workspace_root, options.return_root || options.workspace_root);
  return withWorktreeLock(place, () => registerWorktree(options));
}

export async function bindWorkflowPlanSetId({ workspace_root, repository_root = workspace_root, plan_set_id, feature_name } = {}) {
  validatePlanSetId(plan_set_id);
  if (Boolean(plan_set_id) === Boolean(feature_name)) throw new Error('Provide exactly one of plan_set_id or feature_name');
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
    const record = await readWorktreeRecord(place);
    if (record.state !== 'active') throw new Error('Only an active worktree can bind plan_set_id');
    if (record.plan_set_id) {
      if (plan_set_id && record.plan_set_id !== plan_set_id) throw new Error('Worktree plan_set_id is immutable once set');
      return record;
    }
    const chosen = plan_set_id || planSetSlug(feature_name);
    const updated = { ...record, plan_set_id: chosen };
    await writeWorktreeRecord(place, updated);
    return updated;
  });
}

export async function recordWorkflowSession({ workspace_root, repository_root = workspace_root, key, session_id, execution_id } = {}) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(key) || !WORKTREE_ID.test(session_id || '') || typeof execution_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(execution_id)) throw new Error('Invalid workflow session entry');
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
    const record = await readWorktreeRecord(place);
    if (record.state !== 'active') throw new Error('Only an active worktree can record an agent session');
    if (record.workspace !== place.workspace || record.common !== place.common || record.session_directory !== place.session_directory) throw new Error('Worktree ownership mismatch while recording an agent session');
    const current = await describe(place.workspace);
    if (current.common !== record.common || current.branch !== record.branch || current.git_dir !== record.git_dir) throw new Error('Worktree changed while recording an agent session');
    const entry = { session_id, execution_id, updated_at: new Date().toISOString() };
    const updated = { ...record, agent_sessions: { ...(record.agent_sessions || {}), [key]: entry } };
    await writeWorktreeRecord(place, updated);
    return entry;
  });
}

export async function recordWorktreeStage({ workspace_root, repository_root, current_stage } = {}) {
  if (!Object.values(WORKTREE_STAGE).includes(current_stage)) throw new Error('Invalid worktree current_stage');
  const place = await location(workspace_root, repository_root);
  return withWorktreeLock(place, async () => {
    const record = await readWorktreeRecord(place);
    if (record.state !== 'active' || record.workspace !== place.workspace || record.common !== place.common || record.session_directory !== place.session_directory) throw new Error('Worktree ownership mismatch while recording stage');
    const actual = await describe(place.workspace);
    if (actual.common !== record.common || actual.branch !== record.branch || actual.git_dir !== record.git_dir) throw new Error('Worktree changed while recording stage');
    await writeWorktreeRecord(place, { ...record, current_stage });
  });
}

export async function createWorkflowWorktree({ workspace_root, return_root = null, branch = null, plan_set_id, feature_name, signal = null } = {}) {
  if (!isAbsolute(workspace_root || '')) throw new Error('Absolute source workspace is required');
  if (plan_set_id && feature_name) throw new Error('Provide either plan_set_id or feature_name');
  if (feature_name) plan_set_id = planSetSlug(feature_name);
  validatePlanSetId(plan_set_id);
  const sourceWorkspace = await realpath(workspace_root);
  const returnRoot = await realpath(return_root || sourceWorkspace);
  const [sourceStore, returnStore] = await Promise.all([storage(sourceWorkspace), storage(returnRoot)]);
  if (sourceStore.common !== returnStore.common) throw new Error('Source and return roots must share a Git common directory');
  const worktreeId = randomUUID();
  const workspace = join(dirname(returnRoot), '.harness-worktrees', basename(returnRoot), worktreeId);
  const sessionBranch = branch || `harness/worktree/${worktreeId}`;
  await git(workspace_root, ['check-ref-format', '--branch', sessionBranch]);
  if (!branch && await git(workspace_root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source workspace must be clean before creating a session branch');
  await mkdir(dirname(workspace), { recursive: true });
  const ownership = await reserveWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, branch: sessionBranch, plan_set_id });
  try {
    if (branch) await git(workspace_root, ['worktree', 'add', '--', workspace, branch]);
    else await git(workspace_root, ['worktree', 'add', '-b', sessionBranch, '--', workspace, 'main']);
    signal?.throwIfAborted();
    const record = await registerWorkflowWorktree({ workspace_root: workspace, return_root: returnRoot, plan_set_id });
    await provisionWorktreeRuntime(sourceWorkspace, workspace);
    return { ...record, source_workspace: sourceWorkspace };
  } catch (error) {
    error.worktree_cleanup = await finishWorkflowWorktree({ workspace_root: workspace, repository_root: returnRoot, worktree_id: ownership.worktree_id, outcome: 'failed' });
    error.message += `; allocation cleanup=${error.worktree_cleanup.state}; workspace=${workspace}`;
    throw error;
  }
}

async function finishRegisteredWorktree({ workspace_root, repository_root = workspace_root, worktree_id = null, outcome = 'aborted' } = {}) {
  if (!['completed', 'aborted', 'failed', 'handoff'].includes(outcome)) throw new Error('Invalid worktree exit outcome');
  const place = await location(workspace_root, repository_root);
  let record;
  try { record = await readWorktreeRecord(place); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'not-owned', workspace_root, reason: 'No worktree.json; workspace preserved' }; throw error; }
  if (record.workspace !== place.workspace || record.common !== place.common || (worktree_id && record.worktree_id !== worktree_id)) throw new Error('Worktree ownership mismatch');
  const exists = await lstat(place.workspace).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) {
    const current = await describe(place.workspace);
    if (current.common !== record.common || current.branch !== record.branch || (record.git_dir && current.git_dir !== record.git_dir)) throw new Error('Worktree identity/branch changed; cleanup refused');
    await git(record.return_root, ['worktree', 'remove', '--force', '--', place.workspace]);
  }
  const listed = await git(record.return_root, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.split('\0').includes(`worktree ${place.workspace}`)) throw new Error('Worktree is still registered after removal');
  if (place.worktree_file.startsWith(`${place.directory}/`) === false) await unlink(place.worktree_file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return { state: 'removed', workspace_root, return_root: record.return_root, outcome };
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
  finally { await lock.close(); await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function finishWorkflowWorktree(options = {}) {
  const place = await location(options.workspace_root, options.repository_root || options.workspace_root);
  return withWorktreeLock(place, () => finishRegisteredWorktree(options));
}

export async function listWorkflowWorktrees({ workspace_root } = {}) {
  const listing = await git(workspace_root, ['worktree', 'list', '--porcelain', '-z']);
  const workspaces = listing.split('\0').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  const records = await Promise.all(workspaces.map(async (workspace) => {
    try { return parseWorktreeRecord(await readFile(join(workspace, '.io', 'worktree.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  return records.filter((record) => record && record.state !== 'removed');
}
