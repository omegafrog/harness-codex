import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertReviewAttempt, assertActiveReviewAdmission, inspectReviewHistory } from './review-attempts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
const UNFINALIZED_STATUS = /\b(?:draft|pending|in progress|under review|for review|review required)\b/i;
async function assertSpecFinalized(root, ticketId) {
  for (const name of ['product-spec.md', 'architecture-spec.md']) {
    const path = `docs/specs/${ticketId}/${name}`;
    const markdown = await readFile(join(root, path), 'utf8');
    const statuses = [...markdown.matchAll(/^\s*(?:\*\*Status:\*\*|Status:|status:)\s*(.*?)\s*$/gim)];
    for (const [, status] of statuses) {
      if (UNFINALIZED_STATUS.test(status)) throw new Error(`${path} is not finalized: ${status}`);
    }
  }
}
async function hash(root, path) {
  requireValue(typeof path === 'string' && path && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'Review input must be a relative file path');
  await assertWorkspaceTarget(root, path);
  return createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
export async function snapshotSpecReview({ root, ticketId, input_paths = [] }) {
  requireValue(ID.test(ticketId || ''), 'Valid ticketId is required');
  const directory = `docs/specs/${ticketId}`;
  const paths = new Set([`${directory}/product-spec.md`, `${directory}/architecture-spec.md`]);
  requireValue(input_paths.every((path) => paths.has(path)), 'Spec review inputs are limited to Product and Architecture Specs');
  const inputs = {};
  for (const path of [...paths].sort()) inputs[path] = await hash(root, path);
  return inputs;
}

export async function validateSpecReviewAdmission({ root, admission, requireActive = true }) {
  const target = admission?.target;
  requireValue(admission?.status === 'pass' && target?.workspace_root === root && ID.test(target.ticket_id || '') && target.axis === 'architecture' && target.attempt_id === admission.attempt_id, 'Invalid review admission target');
  const inputs = admission.inputs;
  requireValue(inputs && typeof inputs === 'object' && !Array.isArray(inputs), 'Review admission snapshot is required');
  await assertActiveReviewAdmission({ root, scope: `spec-${target.ticket_id}-${target.axis}`, attemptId: target.attempt_id, inputs, requireActive });
  if (admission.review_delta) {
    const { reviewAdmissionPreviousInputs } = await import('./review-attempts.mjs');
    const { reviewDelta } = await import('./review-delta.mjs');
    const previousInputs = await reviewAdmissionPreviousInputs({ root, scope: `spec-${target.ticket_id}-${target.axis}`, attemptId: target.attempt_id });
    requireValue(JSON.stringify(admission.previous_inputs) === JSON.stringify(previousInputs), 'Review delta baseline does not match history');
    requireValue(JSON.stringify(admission.review_delta) === JSON.stringify(await reviewDelta({ root, inputs, previousInputs })), 'Review delta does not match admitted inputs');
  }
  const current = await snapshotSpecReview({ root, ticketId: target.ticket_id, input_paths: Object.keys(inputs) });
  requireValue(Object.keys(current).length === Object.keys(inputs).length && Object.entries(current).every(([path, digest]) => inputs[path] === digest), 'Review admission snapshot is stale');
  return admission;
}

export async function inspectSpecReviews({ root, ticketId, reviews }) {
  try {
    const record = reviews?.architecture;
    requireValue(record && record.axis === 'architecture' && record.ticket_id === ticketId, 'Architecture review is missing or for another ticket');
    requireValue(typeof record.reviewer_id === 'string' && record.reviewer_id.trim(), 'Architecture reviewer identity is required');
    requireValue(Array.isArray(record.author_ids) && record.author_ids.length > 0 && record.author_ids.every((id) => typeof id === 'string' && id.trim()) && !record.author_ids.includes(record.reviewer_id), 'Reviewer must be independent of Architecture Spec authors');
    requireValue(record.fork_turns === 'none', 'Review must start with an empty context');
    requireValue(record.verdict === 'pass' && Array.isArray(record.findings), 'Architecture review requires revision');
    for (const finding of record.findings) {
      requireValue(['blocker', 'major', 'minor'].includes(finding.severity) && typeof finding.evidence === 'string' && finding.evidence.trim() && typeof finding.description === 'string' && finding.description.trim(), 'Review finding needs severity and concrete evidence');
      requireValue(finding.severity === 'minor', 'Architecture review has unresolved material findings');
    }
    const history = await inspectReviewHistory({ root, scope: `spec-${ticketId}-architecture` });
    const candidate = { ...record, inputs: record.inputs ?? history.last_review?.inputs };
    requireValue(candidate.inputs && typeof candidate.inputs === 'object' && !Array.isArray(candidate.inputs), 'Recorded review input hashes are required');
    const current = await snapshotSpecReview({ root, ticketId, input_paths: Object.keys(candidate.inputs) });
    requireValue(Object.keys(current).length === Object.keys(candidate.inputs).length && Object.entries(current).every(([path, digest]) => candidate.inputs[path] === digest), 'Architecture review inputs changed or required inputs were omitted');
    await assertSpecFinalized(root, ticketId);
    await assertReviewAttempt({ root, scope: `spec-${ticketId}-architecture`, review: candidate });
    return { status: 'pass', reason: 'fresh_spec_reviews_current', violations: [] };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['spec_reviews'] }; }
}

// Planning may advance only from an admitted, current independent review.
export async function requireCurrentSpecReview({ root, ticketId }) {
  requireValue(ID.test(ticketId || ''), 'Valid ticketId is required for Architecture review');
  const history = await inspectReviewHistory({ root, scope: `spec-${ticketId}-architecture` });
  requireValue(history.recorded_state === 'pass' && history.last_review, 'A recorded passing Architecture review is required');
  const result = await inspectSpecReviews({ root, ticketId, reviews: { architecture: history.last_review } });
  requireValue(result.status === 'pass', `Architecture review is not current: ${result.reason}`);
  return result;
}
