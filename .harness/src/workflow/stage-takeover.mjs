import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseWorktreeRecord } from './worktrees.mjs';
import { readNativeCodexOutcome, readRolloutMetadata, readTranscriptEntries, resolveNativeCodexThread } from './native-context.mjs';
import { transcriptInUse } from './requirements-restart.mjs';
import { bindOrchestratorSession, currentClaudeSession, refreshWorkflowProgress } from './startup-state.mjs';
import { runtimeAgentProvider } from './agent-config.mjs';
import { stageExecutionPaths } from './session-output.mjs';
import { nativeCommand } from './stage-cli.mjs';
import { readExecutionInput } from './stage-runtime.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (reason) => new Error(`Takeover refused: ${reason}`);
const stopped = (reason) => new Error(`Running stage cannot be verified stopped: ${reason}`);
// A 0-byte output.json is what a killed host leaves; it holds nothing `finish` could record.
const hasContent = (file) => existsSync(file) && statSync(file).size > 0;
const sessionsDirectory = () => join(resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')), 'sessions');

// A native stage runs as a subagent inside the Codex conversation that spawned it, so the conversation's death kills the
// stage and leaves it `running` with no result. Another conversation may continue it only when the old run provably
// ended: the old orchestrator transcript belongs to this worktree and no process holds it open (a live Codex session keeps
// its own transcript open), the stage's agent transcript is not held open either, and the agent did not finish with an
// output that `finish` could still record. Returns what was verified.
export async function verifyPreviousRunEnded({ root, session, state, entry }) {
  const parent = state.orchestrator_session_id;
  if (!UUID.test(parent || '')) throw stopped('the recorded orchestrator conversation has no Codex session id');
  const { findRollout } = await import('../../../.codex/harness/providers/codex.mjs');
  const found = await findRollout(sessionsDirectory(), parent);
  if (!found) throw stopped('the orchestrator transcript was not found');
  const path = await realpath(found);
  const metadata = await readRolloutMetadata(path);
  const workspace = await realpath(root);
  if (metadata?.id !== parent) throw stopped('the orchestrator transcript does not belong to this worktree');
  const { entries } = await readTranscriptEntries(path);
  const claimedAt = Date.parse(entry.started_at || '');
  const hasWorktreeTurn = Number.isFinite(claimedAt) && entries.some((item) => item.type === 'turn_context' && item.payload?.cwd === workspace && Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) <= claimedAt);
  if (metadata.cwd !== workspace && !hasWorktreeTurn) throw stopped('the orchestrator transcript does not belong to this worktree');
  if (await transcriptInUse(path)) throw stopped('the orchestrator Codex session is still open; close it first');
  if (!entry.native_agent_id) {
    if (!Number.isFinite(claimedAt) || entries.some((item) => item.type === 'event_msg' && item.payload?.item?.type === 'SubAgentActivity' && item.payload.item.kind === 'started' && Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) >= claimedAt)) throw stopped('a subagent started after the claim and was never bound; bind it or inspect it before discarding');
    return 'the orchestrator conversation that started it is closed and no subagent started after the claim';
  }
  const thread = await resolveNativeCodexThread({ root, parentSessionId: parent, stage: entry });
  const agentPath = thread ? await findRollout(sessionsDirectory(), thread) : null;
  if (!agentPath) {
    if (entries.some((item) => item.type === 'event_msg' && item.payload?.item?.type === 'SubAgentActivity' && item.payload.item.kind === 'started' && Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) >= claimedAt)) throw stopped('a subagent started after the claim but its bound transcript cannot be found');
    return 'the orchestrator conversation that started it is closed and no subagent started after the claim';
  }
  const agentTranscript = await realpath(agentPath);
  const agentMetadata = await readRolloutMetadata(agentTranscript);
  const spawn = agentMetadata?.source?.subagent?.thread_spawn;
  const expectedAgentPath = entry.native_agent_id.startsWith('/') ? entry.native_agent_id : `/root/${entry.native_agent_id}`;
  if (agentMetadata?.id !== thread || agentMetadata.cwd !== workspace || agentMetadata.parent_thread_id !== parent || spawn?.parent_thread_id !== parent || spawn.depth !== 1 || spawn.agent_path !== expectedAgentPath) throw stopped('the bound native agent transcript does not match this stage');
  if (await transcriptInUse(agentTranscript)) throw stopped('the native agent transcript is still open; its agent may still be running');
  const outcome = await readNativeCodexOutcome({ root, parentSessionId: parent, stage: entry });
  if (outcome?.status === 'completed' && hasContent(stageExecutionPaths(root, entry.execution_id, { create: false }).files.raw)) throw refuse(`its native agent already completed and wrote its output; record it with ${nativeCommand('finish', entry.execution_id)}`);
  if (outcome?.status === 'interrupted' || outcome?.status === 'failed') return `native agent ${outcome.status} and the orchestrator conversation that started it is closed`;
  return `no process holds the orchestrator${agentPath ? ' or agent' : ''} transcript`;
}

// The ticket the interrupted run was building, from its recorded input. A 0-byte input (killed host) records none.
const planOf = async (root, executionId) => {
  const plan = (await readExecutionInput({ root, execution_id: executionId }).catch(() => null))?.context?.plan_id;
  return plan ? { plan_id: plan } : {};
};

// The calling conversation: the Codex thread (CODEX_THREAD_ID) or the Claude Code session the command runs in.
export async function callerIdentity(root, env = process.env) {
  const provider = runtimeAgentProvider(env);
  if (provider === 'codex') return { provider, sessionId: env.CODEX_THREAD_ID || null };
  if (provider === 'claude-code') return { provider, sessionId: await currentClaudeSession(root) };
  return { provider: provider || null, sessionId: null };
}

// Moves a stage that a closed Codex conversation left `running` to `failed` (interrupted, nothing recorded as its result)
// and makes the calling conversation (Codex or Claude Code) the workflow's orchestrator, so the same stage can be launched again with a fresh
// execution (`--feedback` resume: the previous input and answers are kept). Project files are never touched, so the
// project tree must be clean; the old state is archived like a restart. Repeating the command for a stage this
// conversation already took over changes nothing.
export async function takeOverInterruptedStage({ root, session, stageId, provider: requestedProvider = null, sessionId: requestedSession = null }) {
  const { provider, sessionId } = requestedProvider && requestedSession ? { provider: requestedProvider, sessionId: requestedSession } : await callerIdentity(root);
  if (!['codex', 'claude-code'].includes(provider)) throw refuse('this command could not identify the calling conversation: no Codex conversation (CODEX_THREAD_ID is not set) and no Claude Code session was detected');
  if (!UUID.test(sessionId || '')) throw refuse(provider === 'codex' ? 'this command needs the id of the current Codex conversation (CODEX_THREAD_ID), which is not set' : 'this command needs the id of the current Claude Code session, which was not found for this worktree');
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
    if (record.state !== 'active' || record.workspace !== root || record.session_directory !== session) throw new Error('Invalid active worktree');
    if (state.schema_version !== 1) throw new Error('Invalid workflow state schema');
    const entry = state.stages?.[stageId];
    if (!entry) throw refuse(`${stageId} is not recorded in the workflow state`);
    if (state.current_stage === stageId && entry.status === 'failed' && entry.taken_over?.session_id === sessionId && (entry.taken_over.provider || 'codex') === provider && entry.taken_over.execution_id === entry.execution_id && entry.native_finished === true) {
      return { status: 'ready', already_taken_over: true, stage_id: stageId, execution_id: entry.execution_id, ...await planOf(root, entry.execution_id), previous_session_id: entry.taken_over.from_session_id, verified: entry.taken_over.verified, backup: entry.taken_over.backup };
    }
    if (state.orchestrator_provider !== 'codex') throw refuse('only a stage that a Codex conversation started can be taken over by another conversation (Codex or Claude Code)');
    if (state.current_stage !== stageId || entry.status !== 'running' || !entry.native_managed || entry.result_ref) throw refuse(`${stageId} must be the current native stage and be running without a result (it is ${entry.status})`);
    if (Object.entries(state.stages).some(([id, item]) => id !== stageId && item?.status === 'running')) throw refuse('another stage is running');
    if (state.orchestrator_session_id === sessionId) throw refuse(`this conversation started ${stageId} itself, so its agent is waited for here, not taken over`);
    const previousSession = state.orchestrator_session_id;
    const verified = await verifyPreviousRunEnded({ root, session, state, entry });
    const dirty = git('status', '--porcelain', '--untracked-files=all').trim();
    if (dirty) {
      const lines = dirty.split('\n');
      throw refuse(`the project worktree has uncommitted changes that the interrupted stage may have left (${lines.slice(0, 8).join('; ')}${lines.length > 8 ? `; and ${lines.length - 8} more` : ''})`);
    }
    const now = new Date().toISOString();
    archive = join(session, 'runtime/restarts', `takeover-${randomUUID()}`);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await writeFile(join(archive, 'state.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'worktree.json'), originalRecord, { flag: 'wx', mode: 0o600 });
    await writeFile(join(archive, 'takeover.json'), JSON.stringify({ stage: stageId, execution_id: entry.execution_id, status: entry.status, from_session_id: previousSession, session_id: sessionId, provider, verified, head: git('rev-parse', 'HEAD').trim(), at: now }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await bindOrchestratorSession({ root, provider, sessionId });
    state.stages = {
      ...state.stages,
      [stageId]: { ...entry, status: 'failed', code: 'EXECUTION_ERROR', reason: `Interrupted: the Codex conversation that started this stage ended before it recorded a result (${verified}); ${provider} conversation ${sessionId} took it over`, updated_at: now, finished_at: now, native_finished: true, taken_over: { at: now, from_session_id: previousSession, session_id: sessionId, provider, execution_id: entry.execution_id, verified, backup: archive } },
    };
    state.status = 'failed';
    state.orchestrator_session_id = sessionId;
    state.orchestrator_provider = provider;
    state.updated_at = now;
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, statePath);
    await refreshWorkflowProgress({ matching_workflow_count: 1, matching_workflows: [{ session_directory: session }], issues: [] }, 'StageTakeover');
    return { status: 'ready', stage_id: stageId, execution_id: entry.execution_id, ...await planOf(root, entry.execution_id), previous_session_id: previousSession, verified, backup: archive };
  } catch (error) {
    if (archive) {
      await writeFile(statePath, original);
      await writeFile(join(session, 'worktree.json'), originalRecord);
    }
    throw error;
  } finally { await rm(lock, { recursive: true }); }
}
