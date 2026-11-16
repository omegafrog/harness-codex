import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PRE_SPEC_STAGES, nextRequiredPreSpecStage } from './worktree-stages.mjs';
import { restartDocuments } from './stage-commit.mjs';
import { parseWorktreeRecord, recordWorktreeStage } from './worktrees.mjs';
import { readNativeCodexOutcome } from './native-context.mjs';
import { assertExecutionStopped } from './execution-state.mjs';
import { refreshWorkflowProgress } from './startup-state.mjs';

// Restore only a contiguous run of Harness-owned commits of the flow before spec-me (requirements and tactical design
// stages), never unrelated project commits.
export async function restartRequirements({ root, session, stageId }) {
  const index = PRE_SPEC_STAGES.indexOf(stageId);
  if (index < 0) throw new Error('Restart target must be a requirements or tactical design stage');
  const statePath = join(session, 'runtime/orchestrator/state.json');
  const lock = join(session, 'runtime/orchestrator/.state.lock');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(lock);
  let archive, changed = [], original, originalRecord;
  try {
    original = await readFile(statePath, 'utf8');
    const state = JSON.parse(original);
    originalRecord = await readFile(join(session, 'worktree.json'), 'utf8');
    const record = parseWorktreeRecord(originalRecord);
    if (record.state !== 'active' || record.workspace !== root || record.session_directory !== session || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.plan_set_id || '')) throw new Error('Invalid active worktree');
    if (state.schema_version !== 1 || state.stages?.[stageId]?.status !== 'completed') throw new Error('Restart target must be completed');
    for (const [id, entry] of Object.entries(state.stages)) {
      if (!PRE_SPEC_STAGES.includes(id) && !['workflow-compose', 'spec-me'].includes(id)) throw new Error('Later workflow stages prevent requirements restart');
      if (entry.status === 'running') {
        if (state.orchestrator_provider !== 'codex' || !entry.native_managed) throw new Error('Running stage cannot be verified stopped');
        const outcome = await readNativeCodexOutcome({ root, parentSessionId: state.orchestrator_session_id, stage: entry });
        if (outcome?.status !== 'interrupted' && outcome?.status !== 'failed') throw new Error('Running stage cannot be verified stopped');
      }
    }
    if (git('status', '--porcelain', '--untracked-files=all').trim()) throw new Error('Restart requires a clean project worktree and index');
    const history = git('log', '--format=%H%x09%s').trim().split('\n').map((line) => line.split('\t'));
    const target = `${stageId}: ${record.plan_set_id}`;
    let position = history.findIndex(([, subject]) => subject === target);
    if (position < 0) throw new Error('Restart checkpoint commit not found');
    const later = new Set(PRE_SPEC_STAGES.slice(index).map((id) => `${id}: ${record.plan_set_id}`));
    if (history.slice(0, position + 1).some(([, subject]) => !later.has(subject))) throw new Error('Unrelated or later commits prevent requirements restart; a workflow created with an earlier stage order must be reviewed before restarting');
    // A user revision commits its stage again, so the checkpoint is the oldest commit of the unbroken run of these stages.
    while (position + 1 < history.length && later.has(history[position + 1][1])) position += 1;
    const base = git('rev-parse', `${history[position][0]}^`).trim();
    const paths = restartDocuments(stageId, record.plan_set_id);
    changed = git('diff', '--name-only', '-z', base, 'HEAD', '--', ...paths).split('\0').filter(Boolean);
    if (changed.some((path) => !paths.some((p) => path === p || path.startsWith(`${p}/`)))) throw new Error('Invalid checkpoint path');
    archive = join(session, 'runtime/restarts', `requirements-${randomUUID()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await writeFile(join(archive, 'state.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'worktree.json'), originalRecord, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'restart.json'), JSON.stringify({ stage: stageId, head: git('rev-parse', 'HEAD').trim(), base, paths: changed }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (changed.length) git('restore', '--source', base, '--worktree', '--', ...changed);
    for (const id of [...PRE_SPEC_STAGES.slice(index), 'spec-me']) delete state.stages[id];
    const previous = index ? PRE_SPEC_STAGES[index - 1] : 'workflow-compose';
    if (state.stages?.[previous]?.status !== 'completed') throw new Error('Previous stage is not completed');
    state.current_stage = previous;
    state.status = 'waiting';
    state.updated_at = new Date().toISOString();
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, statePath);
    await recordWorktreeStage({ workspace_root: root, repository_root: record.return_root, current_stage: previous });
    return { status: 'ready', stage_id: stageId, previous_stage: previous, backup: archive, base_commit: base };
  } catch (error) {
    if (archive) {
      if (changed.length) git('restore', '--source', 'HEAD', '--worktree', '--', ...changed);
      await writeFile(statePath, original);
      await writeFile(join(session, 'worktree.json'), originalRecord);
    }
    throw error;
  } finally { await rm(lock, { recursive: true }); }
}

// True while any process of this user holds the transcript open: a live Codex session keeps its own transcript open.
async function transcriptInUse(path) {
  let pids;
  try { pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Cannot verify that the orchestrator session ended: process information is unavailable on this platform'); throw error; }
  for (const pid of pids) {
    let descriptors;
    try { descriptors = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors) {
      if (await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => null) === path) return true;
    }
  }
  return false;
}

// A claimed stage whose subagent was never bound has no agent transcript to read. The orchestrator's own transcript then
// has to show that it never started a subagent after the claim and that no process still holds the session open.
async function assertUnboundClaimAbandoned({ root, state, entry }) {
  const parent = state.orchestrator_session_id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parent || '') || !Number.isFinite(Date.parse(entry.started_at || ''))) throw new Error('Running stage cannot be verified stopped');
  const { findRollout } = await import('./providers/codex.mjs');
  const found = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), parent);
  if (!found) throw new Error('Running stage cannot be verified stopped: the orchestrator transcript was not found');
  const path = await realpath(found);
  const workspace = await realpath(root);
  const claimedAt = Date.parse(entry.started_at);
  let first = true;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    let item;
    try { item = JSON.parse(line); } catch { throw new Error('Running stage cannot be verified stopped: the orchestrator transcript is unreadable'); }
    if (first) {
      first = false;
      if (item.type !== 'session_meta' || item.payload?.id !== parent || item.payload?.cwd !== workspace) throw new Error('Running stage cannot be verified stopped: the orchestrator transcript does not belong to this worktree');
      continue;
    }
    const activity = item.payload?.item;
    if (item.type === 'event_msg' && activity?.type === 'SubAgentActivity' && activity.kind === 'started' && Date.parse(item.timestamp) >= claimedAt) throw new Error('Running stage cannot be verified stopped: a subagent started after the claim and was never bound; bind it or inspect it before discarding');
  }
  if (await transcriptInUse(path)) throw new Error('Running stage cannot be verified stopped: the orchestrator Codex session is still open; close it first');
}

// A stage an earlier Harness started out of order (spec-me before a tactical design stage that was inserted into the
// flow later) and whose native run ended without a result is dropped from the state, and the workflow returns to the
// stage it was waiting after. The old state is archived like a requirements restart; project files are never touched,
// so the project tree must already be clean and the stage must not have committed anything.
export async function discardOutOfOrderStage({ root, session, stageId }) {
  const statePath = join(session, 'runtime/orchestrator/state.json');
  const lock = join(session, 'runtime/orchestrator/.state.lock');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(lock);
  let archive, original, originalRecord;
  try {
    original = await readFile(statePath, 'utf8');
    const state = JSON.parse(original);
    originalRecord = await readFile(join(session, 'worktree.json'), 'utf8');
    const record = parseWorktreeRecord(originalRecord);
    if (record.state !== 'active' || record.workspace !== root || record.session_directory !== session || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.plan_set_id || '')) throw new Error('Invalid active worktree');
    if (state.schema_version !== 1) throw new Error('Invalid workflow state schema');
    const entry = state.stages?.[stageId];
    if (!entry) throw new Error(`${stageId} is not recorded in the workflow state`);
    if (!nextRequiredPreSpecStage(state.stages, stageId)) throw new Error(`${stageId} is not out of order: only a stage that started before the flow allowed it and recorded no result can be discarded; resume or restart it instead`);
    if (state.current_stage !== stageId || !['running', 'failed', 'cancelled'].includes(entry.status) || !entry.native_managed) throw new Error(`${stageId} must be the current native stage and be running, failed or cancelled`);
    if (Object.entries(state.stages).some(([id, item]) => id !== stageId && item?.status === 'running')) throw new Error('Another stage is running');
    if (state.orchestrator_provider !== 'codex') throw new Error('Only a stage run by a Codex orchestrator can be verified stopped');
    let verified;
    if (entry.status === 'running') {
      if (entry.native_agent_id) {
        const outcome = await readNativeCodexOutcome({ root, parentSessionId: state.orchestrator_session_id, stage: entry });
        if (outcome?.status !== 'interrupted' && outcome?.status !== 'failed') throw new Error('Running stage cannot be verified stopped');
        verified = `native agent ${outcome.status}`;
      } else {
        await assertUnboundClaimAbandoned({ root, state, entry });
        verified = 'no subagent started after the claim and the orchestrator session is closed';
      }
    } else {
      await assertExecutionStopped(entry);
      verified = `native stage ${entry.status}`;
    }
    if (git('status', '--porcelain', '--untracked-files=all').trim()) throw new Error('Discarding requires a clean project worktree and index');
    if (git('log', '--format=%s').split('\n').includes(`${stageId}: ${record.plan_set_id}`)) throw new Error(`${stageId} already committed documents; restart it instead`);
    const previous = Object.entries(state.stages)
      .filter(([id, item]) => id !== stageId && item?.status === 'completed' && item.code === 'OK')
      .sort(([, a], [, b]) => Date.parse(b.finished_at || b.updated_at || 0) - Date.parse(a.finished_at || a.updated_at || 0))[0]?.[0];
    if (!previous) throw new Error('No completed stage to return to');
    archive = join(session, 'runtime/restarts', `out-of-order-${randomUUID()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await writeFile(join(archive, 'state.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'worktree.json'), originalRecord, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'discard.json'), JSON.stringify({ stage: stageId, execution_id: entry.execution_id, status: entry.status, verified, previous_stage: previous, head: git('rev-parse', 'HEAD').trim() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    delete state.stages[stageId];
    state.current_stage = previous;
    state.status = 'waiting';
    state.updated_at = new Date().toISOString();
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, statePath);
    await recordWorktreeStage({ workspace_root: root, repository_root: record.return_root, current_stage: state.stages[previous].skill || previous });
    await refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [{ session_directory: session }], issues: [] }, 'StageDiscard');
    return { status: 'ready', stage_id: stageId, execution_id: entry.execution_id, previous_stage: previous, verified, backup: archive };
  } catch (error) {
    if (archive) {
      await writeFile(statePath, original);
      await writeFile(join(session, 'worktree.json'), originalRecord);
    }
    throw error;
  } finally { await rm(lock, { recursive: true }); }
}
