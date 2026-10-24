import { randomUUID } from 'node:crypto';
import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { sessionOutputPath } from './session-output.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
function requireValue(value, message) { if (!value) throw new Error(message); }
function historyPath(root, scope) {
  requireValue(ID.test(scope || ''), 'Valid review scope is required');
  return sessionOutputPath(root, `runtime/reviews/${scope}.json`);
}
async function readHistory(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { attempts: [] }; throw error; }
}

// Serialize admission and result writes; the persisted active attempt owns the review slot.
export async function updateReviewAttempt({ root, scope, action, inputs, attemptId, review, reason }) {
  const path = historyPath(root, scope);
  const lock = await open(`${path}.lock`, 'wx').catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Review history is being updated; retry after the current command finishes');
    throw error;
  });
  try {
    const history = await readHistory(path), last = history.attempts.at(-1);
    let result;
    if (action === 'begin') {
      requireValue(inputs && Object.keys(inputs).length > 0, 'Review inputs are required');
      requireValue(last?.status !== 'active', 'A review is already active; record its result or abort it before dispatch');
      requireValue(!last || last.status === 'aborted' || !same(last.inputs, inputs), 'Review inputs are unchanged; reuse the current result or resolve the findings before dispatch');
      const round = !last || last.status === 'pass' || history.resolution?.after === history.attempts.length ? 1 : last.round + 1;
      requireValue(round <= 3, 'Review retry budget exhausted (initial review plus two retries); present unresolved findings for a scope or decision resolution');
      const attempt = { id: randomUUID(), round, status: 'active', inputs };
      history.attempts.push(attempt);
      result = { status: 'pass', attempt_id: attempt.id, round, inputs, previous_findings: history.attempts.findLast((item) => item.review)?.review.findings || [] };
    } else if (action === 'resolve') {
      requireValue(last && last.status !== 'active' && last.status !== 'pass' && last.round === 3, 'Resolve requires an exhausted review cycle');
      requireValue(typeof reason === 'string' && reason.trim(), 'Explicit user scope/decision resolution is required');
      history.resolution = { after: history.attempts.length, reason };
      result = { status: 'pass', reason: 'user_resolution_recorded' };
    } else {
      requireValue(last?.status === 'active' && last.id === attemptId, 'No active review matches this attempt ID');
      if (action === 'abort') {
        requireValue(typeof reason === 'string' && reason.trim(), 'Abort reason is required');
        last.status = 'aborted'; last.reason = reason;
      } else {
        requireValue(action === 'record', 'Unknown review attempt action');
        requireValue(review && ['pass', 'revise', 'reject', 'blocked'].includes(review.verdict), 'Review verdict is required');
        requireValue(typeof review.reviewer_id === 'string' && review.reviewer_id.trim() && Array.isArray(review.author_ids) && review.author_ids.length && review.author_ids.every((id) => typeof id === 'string' && id.trim()) && !review.author_ids.includes(review.reviewer_id) && review.fork_turns === 'none', 'A fresh independent reviewer is required');
        requireValue(!history.attempts.some((item) => item.review?.reviewer_id === review.reviewer_id), 'Each retry requires a new reviewer');
        requireValue(Array.isArray(review.findings) && review.findings.every((item) => ['blocker', 'major', 'minor'].includes(item.severity) && typeof item.description === 'string' && item.description.trim() && typeof item.evidence === 'string' && item.evidence.trim()), 'Findings need severity, description and evidence');
        requireValue(review.inputs && Object.entries(last.inputs).every(([key, digest]) => review.inputs[key] === digest), 'Review did not use the admitted snapshot');
        last.review = review;
        const current = same(review.inputs, inputs);
        last.status = !current ? 'stale' : review.verdict === 'pass' && review.findings.every((item) => item.severity === 'minor') ? 'pass' : 'revise';
      }
      result = { status: last.status === 'pass' || action === 'abort' ? 'pass' : 'blocked', reason: last.status, attempt_id: last.id, round: last.round, findings: last.review?.findings || [] };
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    return result;
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}

export async function assertReviewAttempt({ root, scope, review }) {
  const history = await readHistory(historyPath(root, scope));
  const last = history.attempts.at(-1);
  // Existing receipts predate admission history; newly admitted reviews must finish their slot.
  if (!last) return;
  requireValue(last.status === 'pass' && last.review?.reviewer_id === review?.reviewer_id && same(last.review.inputs, review.inputs), 'Record a passing result for the current review attempt before advancing');
}
