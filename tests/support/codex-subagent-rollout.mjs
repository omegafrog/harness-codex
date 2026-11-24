// Codex subagent rollouts in the shape a real run records (Codex CLI 0.171, observed on a finished tactical-data and a
// domain-model worker), with every id, path and message replaced. The rows that matter to Harness are:
//   session_meta        -> payload.source.subagent.thread_spawn {parent_thread_id, depth, agent_path, agent_role}
//   event_msg           -> task_started {turn_id, root_turn_id, turn_attribution}
//   turn_context        -> {turn_id, model, effort, collaboration_mode.settings.reasoning_effort}
//   event_msg           -> item_completed AgentMessage (phase final_answer)
//   event_msg           -> task_complete {turn_id, last_agent_message, started_at, completed_at, duration_ms}
// The SubagentStop hook of a real run fires after the final answer is written and before task_complete is appended
// (about 20-30 ms), so a rollout is built in two parts: `stoppedRows` is what the hook can read, `completeRow` follows it.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

export const parentRollout = ({ parentId, cwd, childId, agentPath, startedAt = iso(1000) }) => [
  { timestamp: startedAt, ordinal: 0, type: 'session_meta', payload: { id: parentId, session_id: parentId, cwd, originator: 'codex_exec', cli_version: '0.171.0', timestamp: startedAt } },
  { timestamp: startedAt, type: 'event_msg', payload: { type: 'item_completed', thread_id: parentId, turn_id: 'turn-root', item: { type: 'SubAgentActivity', model: 'gpt-6-luna', reasoning_effort: 'medium', id: 'call-spawn', kind: 'started', agent_thread_id: childId, agent_path: agentPath } } },
];

export function childRollout({ parentId, childId, cwd, agentPath, agentRole = 'workflow_stage', turnId = 'turn-child-1', model = 'gpt-6-luna', effort = 'medium', startedAt = iso(1500) }) {
  const rootTurn = 'turn-root';
  return {
    stoppedRows: [
      { timestamp: startedAt, ordinal: 0, type: 'session_meta', payload: { account_scoped: true, session_id: parentId, id: childId, parent_thread_id: parentId, timestamp: startedAt, cwd, runtime_workspace_roots: [cwd], originator: 'codex_exec', cli_version: '0.171.0', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath, agent_nickname: 'Worker', agent_role: agentRole } } }, thread_source: 'subagent', agent_nickname: 'Worker', agent_role: agentRole, agent_path: agentPath, model_provider: 'openai' } },
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'task_started', turn_attribution: { turn_id: turnId, turn_trigger: 'exec', parent_turn_id: rootTurn, initiating_agent_path: '/root', root_turn_id: rootTurn }, turn_id: turnId, root_turn_id: rootTurn, started_at: 1795431442, model_context_window: 258400, collaboration_mode_kind: 'default' } },
      { timestamp: startedAt, type: 'turn_context', payload: { turn_id: turnId, root_turn_id: rootTurn, cwd, approval_policy: 'never', approvals_reviewer: 'user', permission_profile: { type: 'disabled' }, model, collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort, developer_instructions: null } }, multi_agent_version: 'v2', effort, summary: 'none', sandbox_policy: { type: 'danger-full-access' } } },
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: childId, thread_settings: { model, reasoning_effort: effort, cwd } } },
    ],
    // The worker's last message and token accounting, written before the SubagentStop hook runs.
    finalRows: (text) => [
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'item_completed', thread_id: childId, turn_id: turnId, item: { type: 'AgentMessage', id: 'msg-final', content: [{ type: 'Text', text }], phase: 'final_answer' }, content_token_count: 198 } },
      { timestamp: startedAt, type: 'response_item', payload: { type: 'message', status: 'completed', id: 'msg-final', role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }], phase: 'final_answer' } },
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 776546, cached_input_tokens: 733056, output_tokens: 6354, reasoning_output_tokens: 1347, total_tokens: 782900 } } } },
    ],
    // `last_agent_message` is the final message, or null when the worker ended without one.
    completeRow: (lastAgentMessage) => ({ timestamp: startedAt, type: 'event_msg', payload: { type: 'task_complete', root_turn_id: rootTurn, turn_id: turnId, last_agent_message: lastAgentMessage, started_at: 1795431442, completed_at: 1795431583, duration_ms: 141798, time_to_first_token_ms: 2747 } }),
    failedRow: (message) => ({ timestamp: startedAt, type: 'event_msg', payload: { type: 'task_complete', root_turn_id: rootTurn, turn_id: turnId, error: { message }, last_agent_message: null } }),
    abortedRow: () => ({ timestamp: startedAt, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' } }),
  };
}

export const rolloutText = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
export async function writeRollout(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rolloutText(rows));
}
export const appendRollout = (path, rows) => appendFile(path, rolloutText(rows));
export const rolloutPath = (sessionsDirectory, id) => join(sessionsDirectory, '2026', '11', '23', `rollout-2026-11-23T10-00-00-${id}.jsonl`);
