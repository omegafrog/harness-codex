import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { parseWorktreeRecord } from './worktrees.mjs';
import { readExecutionInput, validateSkillInput } from './stage-runtime.mjs';
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

export async function readTranscriptEntries(path, { maxBytes = 32 * 1024 * 1024, tolerateMalformedRows = true } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Unsafe or oversized Codex transcript');
    const text = await handle.readFile('utf8');
    const entries = [];
    let malformedRows = 0;
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); }
      catch (error) {
        malformedRows += 1;
        if (!tolerateMalformedRows || index === 0) throw new Error(`Malformed Codex transcript row ${index + 1}`, { cause: error });
      }
    }
    return { entries, malformedRows };
  } finally { await handle.close(); }
}

function extractCompletedCodexTurns(entries) {
  const turns = new Map();
  const ensure = (id) => {
    if (!turns.has(id)) turns.set(id, { turn_id: id, status: 'running' });
    return turns.get(id);
  };
  for (const entry of entries) {
    if (entry.type === 'turn_context' && typeof entry.payload?.turn_id === 'string') {
      const turn = ensure(entry.payload.turn_id);
      const { model, effort } = entry.payload;
      if (typeof model === 'string' && typeof effort === 'string') {
        turn.model = model;
        turn.reasoning_effort = effort;
      }
      continue;
    }
    if (entry.type !== 'event_msg') continue;
    const event = entry.payload || {};
    if (typeof event.turn_id !== 'string') continue;
    if (event.type === 'task_started') ensure(event.turn_id);
    else if (event.type === 'task_complete') ensure(event.turn_id).status = event.error ? 'failed' : 'completed';
    else if (event.type === 'turn_aborted') ensure(event.turn_id).status = 'interrupted';
  }
  return [...turns.values()].filter((turn) => turn.status === 'completed');
}

export async function resolveNativeCodexThread({ root, parentSessionId, stage }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentSessionId || '') || !stage?.native_agent_id) return null;
  const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
  const path = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), parentSessionId);
  if (!path) return null;
  const workspace = await realpath(root);
  const { entries } = await readTranscriptEntries(path);
  const metadata = entries[0]?.payload;
  const claimedAt = Date.parse(stage.started_at || '');
  const hasWorktreeTurn = Number.isFinite(claimedAt) && entries.some((entry) => entry.type === 'turn_context' && entry.payload?.cwd === workspace && Number.isFinite(Date.parse(entry.timestamp)) && Date.parse(entry.timestamp) <= claimedAt);
  if (entries[0]?.type !== 'session_meta' || metadata?.id !== parentSessionId || metadata?.cwd !== workspace && !hasWorktreeTurn) return null;
  const previousEnd = [...(stage.attempts || [])].reverse().find((item) => item.finished_at)?.finished_at;
  const cutoff = Date.parse(previousEnd || stage.started_at || '');
  if (!Number.isFinite(cutoff)) return null;
  const expectedPath = stage.native_agent_id.startsWith('/') ? stage.native_agent_id : `/root/${stage.native_agent_id}`;
  const candidates = new Set();
  for (const entry of entries.slice(1)) {
    const item = entry.payload?.item;
    const timestamp = Date.parse(entry.timestamp);
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'item_completed' || item?.type !== 'SubAgentActivity' || item.kind !== 'started' || item.agent_path !== expectedPath || !Number.isFinite(timestamp) || timestamp < cutoff || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.agent_thread_id || '')) continue;
    candidates.add(item.agent_thread_id);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export async function readNativeCodexOutcome({ root, parentSessionId, stage }, resolvedThreadId = null) {
  const threadId = resolvedThreadId || await resolveNativeCodexThread({ root, parentSessionId, stage });
  if (!threadId) return null;
  const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
  const path = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), threadId);
  if (!path) return null;
  const workspace = await realpath(root);
  const { entries } = await readTranscriptEntries(path);
  const metadata = entries[0]?.payload;
  const spawn = metadata?.source?.subagent?.thread_spawn;
  const expectedPath = stage.native_agent_id.startsWith('/') ? stage.native_agent_id : `/root/${stage.native_agent_id}`;
  if (entries[0]?.type !== 'session_meta' || metadata?.id !== threadId || metadata.cwd !== workspace || metadata.parent_thread_id !== parentSessionId || spawn?.parent_thread_id !== parentSessionId || spawn.depth !== 1 || spawn.agent_path !== expectedPath) return null;
  let turn = null, outcome = null;
  for (const entry of entries.slice(1)) {
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
}

export async function verifyNativeCodexWorkerBinding({ root, parentSessionId, stage, nativeAgentId, requestedBinding }) {
  if (typeof nativeAgentId !== 'string' || !nativeAgentId.trim()) return { status: 'unavailable', reason: 'agent_id_unavailable' };
  const normalizedAgentId = nativeAgentId.startsWith('/') ? nativeAgentId : `/root/${nativeAgentId}`;
  const candidateStage = { ...stage, native_agent_id: normalizedAgentId };
  const threadId = await resolveNativeCodexThread({ root, parentSessionId, stage: candidateStage });
  if (!threadId) return { status: 'unavailable', reason: 'parent_child_binding_not_found' };
  const outcome = await readNativeCodexOutcome({ root, parentSessionId, stage: candidateStage }, threadId);
  if (outcome?.status !== 'completed') return { status: 'unavailable', reason: 'native_worker_not_completed', thread_id: threadId, outcome: outcome?.status || null };
  const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
  const transcriptPath = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), threadId);
  if (!transcriptPath) return { status: 'unavailable', reason: 'native_worker_transcript_missing', thread_id: threadId };
  const { entries } = await readTranscriptEntries(transcriptPath, { maxBytes: 32 * 1024 * 1024 });
  const turns = extractCompletedCodexTurns(entries);
  if (!turns.length) return { status: 'unavailable', reason: 'completed_turn_metadata_missing', thread_id: threadId };
  const mismatches = turns.filter((turn) => turn.status !== 'completed' || turn.model !== requestedBinding?.model || turn.reasoning_effort !== requestedBinding?.reasoning_effort);
  if (mismatches.length) return { status: 'mismatch', reason: 'requested_binding_mismatch', thread_id: threadId, turns };
  return { status: 'verified', agent_id: normalizedAgentId, thread_id: threadId, outcome: 'completed', turns };
}

async function captureNativeCodexAttestation({ root, session, executionId, stageId, stage, parentSessionId, event, source = 'codex-subagent-stop-hook' }) {
  const attestation = {
    schema_version: 1,
    source,
    execution_id: executionId,
    stage_id: stageId,
    parent_session_id: parentSessionId,
    native_agent_id: stage.native_agent_id,
    thread_id: event.agent_id,
    captured_at: new Date().toISOString(),
    status: 'unavailable',
    turns: [],
  };
  try {
    if (event.hook_event_name !== 'SubagentStop' || typeof event.agent_transcript_path !== 'string') throw new Error('transcript_unavailable');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.agent_id || '')) throw new Error('thread_id_unavailable');
    const sessionsRoot = await realpath(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'));
    const transcriptPath = await realpath(event.agent_transcript_path);
    if (!transcriptPath.startsWith(`${sessionsRoot}${sep}`) || !basename(transcriptPath).endsWith(`-${event.agent_id}.jsonl`)) throw new Error('transcript_path_mismatch');
    const { entries, malformedRows } = await readTranscriptEntries(transcriptPath, { maxBytes: 32 * 1024 * 1024 });
    const metadata = entries[0]?.payload;
    const spawn = metadata?.source?.subagent?.thread_spawn;
    const expectedPath = stage.native_agent_id.startsWith('/') ? stage.native_agent_id : `/root/${stage.native_agent_id}`;
    if (entries[0]?.type !== 'session_meta' || metadata.id !== event.agent_id || metadata.cwd !== root || metadata.parent_thread_id !== parentSessionId || spawn?.parent_thread_id !== parentSessionId || spawn.depth !== 1 || spawn.agent_path !== expectedPath) throw new Error('transcript_identity_mismatch');
    attestation.turns = extractCompletedCodexTurns(entries);
    if (!attestation.turns.length) throw new Error('completed_turn_metadata_missing');
    attestation.status = 'captured';
    attestation.malformed_rows_skipped = malformedRows;
  } catch (error) {
    attestation.reason = error.message === 'Unsafe or oversized Codex transcript' ? 'transcript_unreadable' : error.message;
  }
  const relative = `runtime/executions/${executionId}/native-attestation.jsonl`;
  await assertWorkspaceTarget(session, relative);
  const directory = join(session, 'runtime/executions', executionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(session, relative), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('Unsafe native attestation log');
    await file.writeFile(`${JSON.stringify(attestation)}\n`);
  } finally { await file.close(); }
}

// Codex's SubagentStop hook can run just before the child rollout receives its final task_complete row.
// Re-read only a child proven to have been spawned by this parent/stage after the worker has ended.
// This closes that timing window while keeping the same identity and completed-turn checks as the hook.
export async function refreshNativeCodexAttestation({ root, parentSessionId, stage }) {
  const threadId = await resolveNativeCodexThread({ root, parentSessionId, stage });
  if (!threadId || !stage?.execution_id) return null;
  const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
  const transcriptPath = await findRollout(join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions'), threadId);
  if (!transcriptPath) return null;
  const workspace = await realpath(root);
  await captureNativeCodexAttestation({
    root: workspace,
    session: join(workspace, '.io'),
    executionId: stage.execution_id,
    stageId: stage.stage_id || stage.skill,
    stage,
    parentSessionId,
    event: { hook_event_name: 'SubagentStop', agent_id: threadId, agent_transcript_path: transcriptPath },
    source: 'codex-finish-transcript-refresh',
  });
  return readNativeCodexAttestation({ root: workspace, parentSessionId, stage });
}

export async function readNativeCodexAttestation({ root, parentSessionId, stage }) {
  const executionId = stage?.execution_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) return { status: 'unavailable', reason: 'execution_id_invalid' };
  const stageIds = new Set([stage.stage_id, stage.skill].filter((value) => typeof value === 'string' && value));
  const session = join(await realpath(root), '.io');
  const relative = `runtime/executions/${executionId}/native-attestation.jsonl`;
  await assertWorkspaceTarget(session, relative);
  let file;
  try {
    file = await open(join(session, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) return { status: 'invalid', reason: 'attestation_file_invalid' };
    const rows = (await file.readFile('utf8')).split('\n').filter(Boolean);
    let latest = null;
    for (const row of rows) {
      let entry;
      try { entry = JSON.parse(row); } catch { return { status: 'invalid', reason: 'attestation_record_malformed' }; }
      if (entry.schema_version !== 1 || entry.execution_id !== executionId || !stageIds.has(entry.stage_id) || entry.parent_session_id !== parentSessionId || entry.native_agent_id !== stage.native_agent_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.thread_id || '')) return { status: 'invalid', reason: 'attestation_binding_mismatch' };
      latest = entry;
    }
    if (!latest) return { status: 'unavailable', reason: 'attestation_not_recorded' };
    return latest;
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unavailable', reason: 'attestation_not_recorded' };
    throw error;
  } finally { if (file) await file.close(); }
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
  if (state.orchestrator_provider === 'codex' && event.hook_event_name === 'SubagentStop') {
    const stageId = Object.entries(state.stages || {}).find(([, stage]) => stage === matches[0])?.[0] || matches[0].skill || 'unknown';
    await captureNativeCodexAttestation({ root: workspace, session, executionId: matches[0].execution_id, stageId, stage: matches[0], parentSessionId: state.orchestrator_session_id, event });
  }
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
      const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
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
        const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
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
        const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
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
