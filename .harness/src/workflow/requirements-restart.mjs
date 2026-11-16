import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REQUIREMENTS_STAGES } from './worktree-stages.mjs';
import { parseWorktreeRecord, recordWorktreeStage } from './worktrees.mjs';
import { readNativeCodexOutcome } from './native-context.mjs';

// Restore only a contiguous run of Harness-owned requirement commits, never unrelated project commits.
export async function restartRequirements({ root, session, stageId }) {
  const index = REQUIREMENTS_STAGES.indexOf(stageId);
  if (index < 0) throw new Error('Restart target must be a requirements stage');
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
      if (!REQUIREMENTS_STAGES.includes(id) && !['workflow-compose', 'spec-me'].includes(id)) throw new Error('Later workflow stages prevent requirements restart');
      if (entry.status === 'running') {
        if (state.orchestrator_provider !== 'codex' || !entry.native_managed) throw new Error('Running stage cannot be verified stopped');
        const outcome = await readNativeCodexOutcome({ root, parentSessionId: state.orchestrator_session_id, stage: entry });
        if (outcome?.status !== 'interrupted' && outcome?.status !== 'failed') throw new Error('Running stage cannot be verified stopped');
      }
    }
    if (git('status', '--porcelain', '--untracked-files=all').trim()) throw new Error('Restart requires a clean project worktree and index');
    const history = git('log', '--format=%H%x09%s').trim().split('\n').map((line) => line.split('\t'));
    const target = `${stageId}: ${record.plan_set_id}`;
    const position = history.findIndex(([, subject]) => subject === target);
    if (position < 0) throw new Error('Restart checkpoint commit not found');
    const later = new Set(REQUIREMENTS_STAGES.slice(index).map((id) => `${id}: ${record.plan_set_id}`));
    if (history.slice(0, position + 1).some(([, subject]) => !later.has(subject))) throw new Error('Unrelated or later commits prevent requirements restart');
    const base = git('rev-parse', `${history[position][0]}^`).trim();
    const paths = [`docs/specs/${record.plan_set_id}`, 'CONTEXT.md', 'CONTEXT-MAP.md'];
    changed = git('diff', '--name-only', '-z', base, 'HEAD', '--', ...paths).split('\0').filter(Boolean);
    if (changed.some((path) => !paths.some((p) => path === p || path.startsWith(`${p}/`)))) throw new Error('Invalid checkpoint path');
    archive = join(session, 'runtime/restarts', `requirements-${randomUUID()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await writeFile(join(archive, 'state.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'worktree.json'), originalRecord, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'restart.json'), JSON.stringify({ stage: stageId, head: git('rev-parse', 'HEAD').trim(), base, paths: changed }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (changed.length) git('restore', '--source', base, '--worktree', '--', ...changed);
    for (const id of [...REQUIREMENTS_STAGES.slice(index), 'spec-me']) delete state.stages[id];
    const previous = index ? REQUIREMENTS_STAGES[index - 1] : 'workflow-compose';
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
