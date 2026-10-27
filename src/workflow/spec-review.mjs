import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertReviewAttempt, assertActiveReviewAdmission } from './review-attempts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function hash(root, path) {
  requireValue(typeof path === 'string' && path && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'Review input must be a relative file path');
  await assertWorkspaceTarget(root, path);
  return createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
export async function snapshotSpecReview({ root, ticketId, input_paths = [] }) {
  requireValue(ID.test(ticketId || ''), 'Valid ticketId is required');
  const directory = `docs/specs/${ticketId}`;
  const paths = new Set([`${directory}/request.md`, `${directory}/product-spec.md`, `${directory}/architecture-spec.md`, ...input_paths]);
  const optional = ['CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/architecture/domain-model.md', `${directory}/system-targets.yaml`];
  for (const path of optional) {
    try { await hash(root, path); paths.add(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
    requireValue(record.inputs && typeof record.inputs === 'object' && !Array.isArray(record.inputs), 'Reviewed input hashes are required');
    const current = await snapshotSpecReview({ root, ticketId, input_paths: Object.keys(record.inputs) });
    requireValue(Object.keys(current).length === Object.keys(record.inputs).length && Object.entries(current).every(([path, digest]) => record.inputs[path] === digest), 'Architecture review inputs changed or required inputs were omitted');
    await assertReviewAttempt({ root, scope: `spec-${ticketId}-architecture`, review: record });
    return { status: 'pass', reason: 'fresh_spec_reviews_current', violations: [] };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['spec_reviews'] }; }
}
