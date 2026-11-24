import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Whether the native reviewer bound to an active plan review attempt can still be running. The write guard uses it to
// decide whether the review's file lock still holds; the review history uses it to mark an attempt interrupted. Both read the
// same signals, so a lock that was released is never contradicted by a later `record`:
//   - the reviewer's SubagentStop was recorded (`native_review.stopped`): it has finished, whatever happened to the stage;
//   - the stage execution that owns the review ended (`failed`, `cancelled`, `blocked` or `completed`): a reviewer that is
//     still active inside it is orphaned, because a stage cannot end with an unrecorded native review;
//   - the review attempt was already marked interrupted by an earlier check;
//   - no activity for a bounded time. Activity is the newest of the claim time, the SubagentStart (bind) time and the
//     modification time of the reviewer's own transcript (a working reviewer appends to it continuously; only known when the
//     start event carried `agent_transcript_path`). A claim whose reviewer never reported its start has a short grace
//     period, because SubagentStart follows the dispatch within seconds.
// Histories written before these timestamps existed fall back to the modification time of the review history file, which
// every claim, bind and stop rewrites.
//
// The window is deliberately long: a reviewer that is merely slow keeps its transcript growing, and a reviewer whose
// transcript cannot be read is still allowed half an hour, far above a plan review's normal duration. When a live reviewer
// is judged gone by mistake, its files become writable; an edit then changes the snapshot, so `record` reports the review
// as stale instead of passing it.
export const REVIEWER_BIND_GRACE_MS = 5 * 60 * 1000;
export const REVIEWER_STALE_AFTER_MS = 30 * 60 * 1000;
// A transcript can briefly be unavailable while the provider is creating or rotating its file. Do not release a lock at
// the stale boundary based only on the older bind timestamp; allow one additional liveness window for that signal to recover.
export const REVIEWER_TRANSCRIPT_LOOKUP_GRACE_MS = 5 * 60 * 1000;
export const TERMINAL_EXECUTION_STATUSES = Object.freeze(['failed', 'cancelled', 'blocked', 'completed']);

const time = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };
const mtime = (path) => { try { return typeof path === 'string' && path ? statSync(path).mtimeMs : null; } catch { return null; } };

// The recorded status of one stage execution, from the orchestrator state of the workspace's session (the current entry of
// a stage or one of its earlier attempts); null when the execution is not recorded.
export function executionStatus(root, executionId) {
  if (typeof executionId !== 'string' || !executionId) return null;
  let state;
  for (const name of ['workflow.json', 'state.json']) {
    try { const parsed = JSON.parse(readFileSync(join(root, '.io/runtime/orchestrator', name), 'utf8')); state = parsed.state || parsed; break; } catch { /* try the next record */ }
  }
  for (const entry of Object.values(state?.stages && typeof state.stages === 'object' ? state.stages : {})) {
    if (entry?.execution_id === executionId && typeof entry.status === 'string') return entry.status;
    const attempt = Array.isArray(entry?.attempts) ? entry.attempts.find((item) => item?.execution_id === executionId && typeof item.status === 'string') : null;
    if (attempt) return attempt.status;
  }
  return null;
}

// `attempt` is the last, active attempt of a plan review history. `historyMtimeMs` is the fallback activity time for
// histories without timestamps. Returns { live, state, detail, last_activity_at }; `state` is one of `live`, `unclaimed`,
// `stopped`, `interrupted` (already marked), `execution_terminal`, `unbound_stale` and `stale`.
export function reviewerLiveness({ root, attempt, now = Date.now(), historyMtimeMs = null }) {
  const native = attempt?.native_review;
  if (!native) return { live: false, state: 'unclaimed', detail: 'no reviewer was claimed for this attempt', last_activity_at: null };
  const bound = Boolean(native.agent_id);
  const transcriptMtime = bound ? mtime(native.transcript_path) : null;
  const transcriptUnavailable = bound && typeof native.transcript_path === 'string' && transcriptMtime === null;
  const stamps = [time(native.claimed_at), time(native.started_at), transcriptMtime].filter((value) => value !== null);
  const known = stamps.length ? Math.max(...stamps) : historyMtimeMs;
  const lastActivity = known === null || known === undefined ? null : new Date(known).toISOString();
  if (attempt.interrupted) return { live: false, state: 'interrupted', detail: attempt.interrupted.detail || `already marked interrupted (${attempt.interrupted.reason})`, last_activity_at: lastActivity };
  if (native.stopped === true) return { live: false, state: 'stopped', detail: 'the reviewer stopped; its result waits to be recorded', last_activity_at: native.stopped_at || null };
  const status = executionStatus(root, native.execution_id);
  if (status && TERMINAL_EXECUTION_STATUSES.includes(status)) return { live: false, state: 'execution_terminal', detail: `its stage execution ${native.execution_id} is ${status}`, last_activity_at: lastActivity };
  const window = bound ? REVIEWER_STALE_AFTER_MS + (transcriptUnavailable ? REVIEWER_TRANSCRIPT_LOOKUP_GRACE_MS : 0) : REVIEWER_BIND_GRACE_MS;
  if (known !== null && known !== undefined && now - known > window) {
    return { live: false, state: bound ? 'stale' : 'unbound_stale', detail: bound ? `no reviewer activity since ${lastActivity} (more than ${window / 60000} minutes)` : `the claimed reviewer never started (claimed ${lastActivity}, more than ${window / 60000} minutes ago)`, last_activity_at: lastActivity };
  }
  return { live: true, state: 'live', detail: 'the reviewer is running', last_activity_at: lastActivity };
}

export const isInterruption = (liveness) => !liveness.live && !['stopped', 'unclaimed'].includes(liveness.state);
