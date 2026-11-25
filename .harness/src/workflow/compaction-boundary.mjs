// Claude Code compaction at task boundaries. Claude Code asks (PreCompact, trigger auto) before every request once a context is
// above its auto-compact window; a block postpones that compaction, it does not cancel it. So a Harness sub-agent keeps its
// context while it is inside a unit of work and is compacted at the first boundary after it passed the soft limit:
//   PreCompact        blocks below the soft limit and inside a unit; allows at a recorded boundary or at the hard limit
//   PreToolUse        tells the worker once that a compaction is waiting and which command records its boundary
//   unit-done command / a rejected submission that goes back to the same worker   record the boundary
// The main session is never blocked: its stage Agent runs in the foreground, so it only compacts between stages.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The agent profiles' autoCompactWindow: the smallest value Claude Code accepts. It only decides when Claude Code starts asking.
export const AUTO_COMPACT_WINDOW = 100000;
// Haiku 5.5 bills a whole request 5x once its prompt is over 100K tokens. Opus and Sonnet have no step: their cost grows with
// every cached token re-read on every call, so their limit is a cost choice and the hard limit only bounds one very long unit.
const LIMITS = [[/haiku/i, { soft: 60000, hard: 92000 }], [/./, { soft: 110000, hard: 180000 }]];
export const compactionLimits = (model) => LIMITS.find(([pattern]) => pattern.test(model || 'unknown'))[1];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TAIL = 512 * 1024;
const recordPath = (root, agentId) => join(root, '.io/runtime/compaction', `${agentId}.json`);
const isWorkflow = (root) => typeof root === 'string' && existsSync(join(root, '.io/worktree.json'));

function readRecord(root, agentId) {
  if (!SAFE_ID.test(agentId || '')) return null;
  try { return JSON.parse(readFileSync(recordPath(root, agentId), 'utf8')); } catch { return null; }
}
function writeRecord(root, agentId, record) {
  mkdirSync(join(root, '.io/runtime/compaction'), { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(root, agentId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// The size and model of the agent's last request, from the tail of its own transcript; null when it cannot be read.
export function contextUsage({ transcript_path: transcript, agent_id: agentId }) {
  if (typeof transcript !== 'string' || !SAFE_ID.test(agentId || '')) return null;
  const path = join(transcript.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
  let text;
  try {
    const size = statSync(path).size, length = Math.min(size, TAIL), buffer = Buffer.alloc(length), file = openSync(path, 'r');
    try { readSync(file, buffer, 0, length, size - length); } finally { closeSync(file); }
    text = buffer.toString('utf8');
  } catch { return null; }
  for (const line of text.split('\n').reverse()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const usage = row.type === 'assistant' ? row.message?.usage : null;
    const tokens = usage ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0) : 0;
    if (tokens) return { tokens, model: row.message.model };
  }
  return null;
}

// -> null (no opinion) | { block: reason } | { instructions: text for the summary }
export function compactionDecision(event, harnessAgents) {
  if (event?.hook_event_name !== 'PreCompact' || event.trigger !== 'auto' || !isWorkflow(event.cwd)) return null;
  const { cwd: root, agent_id: agentId } = event;
  if (!agentId) return { instructions: 'This session coordinates a Harness workflow. Keep: the worktree path, the current stage and execution_id, the last envelope and its next step, questions shown but not answered, and the user\'s replies verbatim. Drop tool output. Everything else is on disk: continue with `node .harness/scripts/harness-context.mjs --entry`.' };
  if (!SAFE_ID.test(agentId) || !harnessAgents.includes(event.agent_type)) return null;
  const usage = contextUsage(event);
  if (!usage) return null;
  const { soft, hard } = compactionLimits(usage.model);
  const record = readRecord(root, agentId);
  if (usage.tokens < soft) return { block: 'Below the Harness compaction limit' };
  if (record?.state === 'boundary' || usage.tokens >= hard) {
    rmSync(recordPath(root, agentId), { force: true });
    return { instructions: 'This is a Harness agent. Keep verbatim: its assignment (paths, execution_id, agent_id, submission rule), decisions and answers, finished units with their files and check results, and the remaining units. Drop file contents; they can be read again from their paths.' };
  }
  if (!record) writeRecord(root, agentId, { state: 'pending', tokens: usage.tokens });
  return { block: 'Inside a unit of work; Harness compacts at its end' };
}

// The one-time notice for a worker whose compaction is waiting, or null.
export function pendingCompactionNotice({ cwd: root, agent_id: agentId }) {
  if (!agentId || !isWorkflow(root)) return null;
  const record = readRecord(root, agentId);
  if (record?.state !== 'pending' || record.notified) return null;
  writeRecord(root, agentId, { ...record, notified: true });
  return `Harness: your context is large (${record.tokens} tokens) and will be compacted at your next task boundary. Finish the unit you are in (one document, one acceptance criterion with its check, one E2E use case, one ticket) and do not stop in the middle. If units remain, then run: node .harness/scripts/harness-compaction.mjs unit-done --agent-id ${agentId} - and continue with the next unit. If this is the last unit, just submit.`;
}

// Records that the worker is between two units. Does nothing when no compaction is waiting.
export function recordUnitBoundary(root, agentId) {
  const record = readRecord(root, agentId);
  if (!isWorkflow(root) || !record) return false;
  writeRecord(root, agentId, { ...record, state: 'boundary' });
  return true;
}
