import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseWorktreeRecord } from './worktrees.mjs';
import { readExecutionInput, validateSkillInput } from './skill-execution.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

export async function readRolloutMetadata(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe Codex transcript');
    // Only the first line (session_meta) is needed. It is read directly: a line reader that stops early is still reading
    // the file when the handle closes, which fails on a transcript larger than one read.
    const chunks = [];
    let length = 0, position = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      const used = newline >= 0 ? newline : bytesRead;
      chunks.push(buffer.subarray(0, used));
      length += used;
      position += bytesRead;
      if (newline >= 0 || length > 4 * 1024 * 1024) break;
    }
    try { const entry = JSON.parse(Buffer.concat(chunks).toString('utf8')); return entry.type === 'session_meta' ? entry.payload : null; }
    catch { return null; }
  } finally { await handle.close(); }
}

export async function resolveNativeCodexThread({ root, parentSessionId, stage }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentSessionId || '') || !stage?.native_agent_id) return null;
  const { findRollout } = await import('./providers/codex.mjs');
  const path = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), parentSessionId);
  if (!path) return null;
  const workspace = await realpath(root);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe Codex parent transcript');
    const lines = createInterface({ input: createReadStream(path, { fd: handle.fd, autoClose: false }), crlfDelay: Infinity });
    const previousEnd = [...(stage.attempts || [])].reverse().find((item) => item.finished_at)?.finished_at;
    const cutoff = Date.parse(previousEnd || stage.started_at || '');
    if (!Number.isFinite(cutoff)) return null;
    const expectedPath = stage.native_agent_id.startsWith('/') ? stage.native_agent_id : `/root/${stage.native_agent_id}`;
    const candidates = new Set();
    let first = true;
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { return null; }
      if (first) {
        first = false;
        if (entry.type !== 'session_meta' || entry.payload?.id !== parentSessionId || entry.payload?.cwd !== workspace) return null;
        continue;
      }
      const item = entry.payload?.item;
      const timestamp = Date.parse(entry.timestamp);
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'item_completed' || item?.type !== 'SubAgentActivity' || item.kind !== 'started' || item.agent_path !== expectedPath || !Number.isFinite(timestamp) || timestamp < cutoff || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.agent_thread_id || '')) continue;
      candidates.add(item.agent_thread_id);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  } finally { await handle.close(); }
}

export async function readNativeCodexOutcome({ root, parentSessionId, stage }, resolvedThreadId = null) {
  const threadId = resolvedThreadId || await resolveNativeCodexThread({ root, parentSessionId, stage });
  if (!threadId) return null;
  const { findRollout } = await import('./providers/codex.mjs');
  const path = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), threadId);
  if (!path) return null;
  const workspace = await realpath(root);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe Codex agent transcript');
    const lines = createInterface({ input: createReadStream(path, { fd: handle.fd, autoClose: false }), crlfDelay: Infinity });
    let first = true, turn = null, outcome = null;
    const expectedPath = stage.native_agent_id.startsWith('/') ? stage.native_agent_id : `/root/${stage.native_agent_id}`;
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { return null; }
      if (first) {
        first = false;
        const metadata = entry.payload;
        const spawn = metadata?.source?.subagent?.thread_spawn;
        if (entry.type !== 'session_meta' || metadata?.id !== threadId || metadata.cwd !== workspace || metadata.parent_thread_id !== parentSessionId || spawn?.parent_thread_id !== parentSessionId || spawn.depth !== 1 || spawn.agent_path !== expectedPath) return null;
        continue;
      }
      if (entry.type !== 'event_msg') continue;
      const event = entry.payload || {};
      if (event.type === 'task_started' && typeof event.turn_id === 'string') { turn = event.turn_id; outcome = { status: 'running', thread_id: threadId }; }
      else if (turn && event.turn_id === turn && event.type === 'task_complete') {
        outcome = event.error
          ? typeof event.error.message === 'string' && event.error.message.trim() ? { status: 'failed', thread_id: threadId, error: event.error.message } : null
          : typeof event.last_agent_message === 'string' ? { status: 'completed', thread_id: threadId, output: event.last_agent_message } : null;
      } else if (turn && event.turn_id === turn && event.type === 'turn_aborted') outcome = { status: 'interrupted', thread_id: threadId };
    }
    return outcome;
  } finally { await handle.close(); }
}

export async function recordNativeStageObservation(root, event) {
  const workspace = await realpath(root);
  const session = join(workspace, '.io');
  let record;
  try { record = parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8')); }
  catch { return false; }
  if (record.state !== 'active' || await realpath(record.workspace) !== workspace || record.session_directory !== session) return false;
  let workflow;
  try { workflow = JSON.parse(await readFile(join(session, 'runtime/orchestrator/workflow.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let state = workflow?.state;
  if (!state) {
    try { state = JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const sameParent = event.session_id === state.orchestrator_session_id;
  if (!sameParent && event.session_id !== event.agent_id) return false;
  const matches = [];
  for (const stage of Object.values(state.stages || {})) {
    if (stage.status !== 'running' || !stage.native_managed || !stage.native_agent_id) continue;
    if (sameParent && [stage.native_agent_id, `/root/${stage.native_agent_id}`].includes(event.agent_id)) { matches.push(stage); continue; }
    if (state.orchestrator_provider === 'codex' && /^[0-9a-f-]{36}$/i.test(event.agent_id)) {
      const thread = await resolveNativeCodexThread({ root: workspace, parentSessionId: state.orchestrator_session_id, stage });
      if (thread && thread === event.agent_id) matches.push(stage);
    }
  }
  if (matches.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(matches[0].execution_id)) return false;
  const relative = `runtime/executions/${matches[0].execution_id}/native-observations.jsonl`;
  await assertWorkspaceTarget(session, relative);
  const path = join(session, relative);
  await mkdir(join(session, 'runtime/executions', matches[0].execution_id), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Native observations must be a regular unshared file');
    await file.writeFile(`${JSON.stringify({ event: event.hook_event_name, session_id: event.session_id, agent_id: event.agent_id, agent_type: event.agent_type, observed_at: new Date().toISOString() })}\n`);
  } finally { await file.close(); }
  return true;
}

// Only an exact parent agent/session identity may supply stage context to native review hooks.
// The Claude Code stage subagent has no Agent tool, so the main orchestrator session dispatches the independent
// reviewer on the running stage's behalf. `mainSession` accepts that session (a hook event without an agent_id) when
// exactly one native stage is running in this workspace; any agent inside a stage still needs its exact identity.
export async function nativeHookContext(root, parentIds, { childId = null, agentType = null, mainSession = false } = {}) {
  if (!root || !Array.isArray(parentIds)) return null;
  try {
    const workspace = await realpath(root);
    const session = join(workspace, '.io');
    let record;
    try { record = parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8')); }
    catch { return null; }
    if (record.state !== 'active' || await realpath(record.workspace) !== workspace || record.session_directory !== session) return null;
    let state;
    try { const workflow = JSON.parse(await readFile(join(session, 'runtime/orchestrator/workflow.json'), 'utf8')); state = workflow.state || workflow; }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')); }
    // The main session dispatches a reviewer while the current stage has handed control back (waiting for the review),
    // so its context is the current stage's execution rather than a running native agent.
    let matches = [];
    // The main session may dispatch the reviewer for the current stage. A Claude Code event carries no further proof;
    // a Codex event must come from a thread the orchestrator itself spawned (depth 1) with the reviewer's role, so a
    // reviewer from any other thread is never bound to the stage.
    let dispatchedByMain = false;
    if (mainSession && state.orchestrator_provider === 'claude-code') dispatchedByMain = true;
    else if (mainSession && state.orchestrator_provider === 'codex' && /^[0-9a-f-]{36}$/i.test(childId || '')) {
      const { findRollout } = await import('./providers/codex.mjs');
      const childPath = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), childId);
      const metadata = childPath ? await readRolloutMetadata(childPath) : null;
      const spawn = metadata?.source?.subagent?.thread_spawn;
      dispatchedByMain = metadata?.id === childId && metadata.cwd === workspace && spawn?.depth === 1 && spawn.parent_thread_id === state.orchestrator_session_id && spawn.agent_role === agentType;
    }
    if (dispatchedByMain) {
      const current = state.stages?.[state.current_stage];
      if (current && ['running', 'waiting'].includes(current.status) && current.execution_id) matches = [current];
    } else {
      const identities = new Set(parentIds);
      const stageEntries = Object.values(state.stages || {}).filter((stage) => stage.status === 'running' && stage.native_managed && stage.native_agent_id);
      for (const id of stageEntries.some((stage) => identities.has(stage.native_agent_id)) ? [] : parentIds) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        const { findRollout } = await import('./providers/codex.mjs');
        const path = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), id);
        if (!path) continue;
        const metadata = await readRolloutMetadata(path);
        const spawn = metadata?.source?.subagent?.thread_spawn;
        if (metadata?.id !== id || metadata.cwd !== workspace || spawn?.depth !== 1 || spawn.parent_thread_id !== state.orchestrator_session_id || !/^\/root\/[A-Za-z0-9_-]+$/.test(spawn.agent_path || '')) continue;
        identities.add(spawn.agent_path.split('/').pop());
        identities.add(spawn.agent_path);
      }
      matches = stageEntries.filter((stage) => identities.has(stage.native_agent_id));
      if (!matches.length && state.orchestrator_provider === 'codex' && (parentIds.includes(state.orchestrator_session_id) || parentIds.includes(childId)) && /^[0-9a-f-]{36}$/i.test(childId || '')) {
        const { findRollout } = await import('./providers/codex.mjs');
        const childPath = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), childId);
        if (childPath) {
          const metadata = await readRolloutMetadata(childPath);
          const spawn = metadata?.source?.subagent?.thread_spawn;
          if (metadata?.id === childId && metadata.cwd === workspace && spawn?.depth === 2 && spawn.agent_role === agentType) {
            for (const stage of stageEntries) {
              const thread = await resolveNativeCodexThread({ root: workspace, parentSessionId: state.orchestrator_session_id, stage });
              if (thread && spawn.parent_thread_id === thread && metadata.parent_thread_id === thread) matches.push(stage);
            }
          }
        }
      }
    }
    if (matches.length !== 1) return null;
    const input = await readExecutionInput({ root: workspace, execution_id: matches[0].execution_id });
    await validateSkillInput({ root: workspace, input });
    if (input.session_directory !== session || input.context?.worktree_ref !== join(session, 'worktree.json')) return null;
    return { root: workspace, session, executionId: input.execution_id, planSetId: input.context?.plan_set_id || null };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The execution of the stage that is running or waiting for the main session's review dispatch. Commands such as
// `harness-plan-review.mjs begin` run in the main session, which has no stage agent identity of its own.
export async function currentStageExecutionId(root) {
  if (!root) return null;
  try {
    const workspace = await realpath(root);
    const session = join(workspace, '.io');
    const record = parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8'));
    if (record.state !== 'active' || await realpath(record.workspace) !== workspace || record.session_directory !== session) return null;
    let state;
    try { const workflow = JSON.parse(await readFile(join(session, 'runtime/orchestrator/workflow.json'), 'utf8')); state = workflow.state || workflow; }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')); }
    const current = state.stages?.[state.current_stage];
    if (!current || !['running', 'waiting'].includes(current.status) || !current.execution_id) return null;
    const input = await readExecutionInput({ root: workspace, execution_id: current.execution_id });
    await validateSkillInput({ root: workspace, input });
    if (input.session_directory !== session || input.context?.worktree_ref !== join(session, 'worktree.json')) return null;
    return input.execution_id;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
