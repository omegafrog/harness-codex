import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertReviewAttempt } from './review-attempts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function hash(root, path) {
  requireValue(typeof path === 'string' && path && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'Review input must be a relative file path');
  await assertWorkspaceTarget(root, path);
  return createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
export async function snapshotSpecReview({ root, ticketId, axis, input_paths = [] }) {
  requireValue(ID.test(ticketId || '') && ['product', 'architecture'].includes(axis), 'Valid ticketId and review axis are required');
  const directory = `docs/specs/${ticketId}`;
  const paths = new Set([`${directory}/request.md`, `${directory}/product-spec.md`, ...input_paths]);
  if (axis === 'architecture') paths.add(`${directory}/architecture-spec.md`);
  const optional = ['CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md'];
  if (axis === 'architecture') optional.push('docs/contracts/architecture.md', 'docs/architecture/domain-model.md', `${directory}/system-targets.yaml`);
  for (const path of optional) {
    try { await hash(root, path); paths.add(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function diagrams(path) {
    await assertWorkspaceTarget(root, path);
    const entries = await readdir(join(root, path), { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const file = `${path}/${entry.name}`;
      requireValue(!entry.isSymbolicLink(), 'Review diagrams must not contain symlinks');
      if (entry.isDirectory()) await diagrams(file);
      else paths.add(file);
    }
  }
  await diagrams(`${directory}/diagrams/product`);
  if (axis === 'architecture') await diagrams(`${directory}/diagrams/architecture`);
  const inputs = {};
  for (const path of [...paths].sort()) inputs[path] = await hash(root, path);
  return inputs;
}

export async function inspectSpecReviews({ root, ticketId, reviews, axes = ['product', 'architecture'] }) {
  try {
    requireValue(Array.isArray(axes) && axes.length > 0 && axes.every((axis) => ["product", "architecture"].includes(axis)), "Valid review axes are required");
    const allAuthors = axes.flatMap((axis) => Array.isArray(reviews?.[axis]?.author_ids) ? reviews[axis].author_ids : []);
    const reviewerIds = new Set();
    for (const axis of axes) {
      const record = reviews?.[axis];
      requireValue(record && record.axis === axis && record.ticket_id === ticketId, `${axis} review is missing or for another ticket`);
      requireValue(typeof record.reviewer_id === 'string' && record.reviewer_id.trim() && !reviewerIds.has(record.reviewer_id), 'Use a distinct reviewer for each Spec');
      reviewerIds.add(record.reviewer_id);
      requireValue(Array.isArray(record.author_ids) && record.author_ids.length > 0 && record.author_ids.every((id) => typeof id === 'string' && id.trim()) && !allAuthors.includes(record.reviewer_id), 'Reviewer must be independent of all Spec authors');
      requireValue(record.fork_turns === 'none', 'Review must start with an empty context');
      requireValue(record.verdict === 'pass' && Array.isArray(record.findings), `${axis} review requires revision`);
      for (const finding of record.findings) {
        requireValue(['blocker', 'major', 'minor'].includes(finding.severity) && typeof finding.evidence === 'string' && finding.evidence.trim() && typeof finding.description === 'string' && finding.description.trim(), 'Review finding needs severity and concrete evidence');
        requireValue(finding.severity === 'minor', `${axis} review has unresolved material findings`);
      }
      requireValue(record.inputs && typeof record.inputs === 'object' && !Array.isArray(record.inputs), 'Reviewed input hashes are required');
      const current = await snapshotSpecReview({ root, ticketId, axis, input_paths: Object.keys(record.inputs) });
      requireValue(Object.keys(current).length === Object.keys(record.inputs).length && Object.entries(current).every(([path, digest]) => record.inputs[path] === digest), `${axis} review inputs changed or required inputs were omitted`);
      await assertReviewAttempt({ root, scope: `spec-${ticketId}-${axis}`, review: record });
    }
    return { status: 'pass', reason: 'fresh_spec_reviews_current', violations: [] };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['spec_reviews'] }; }
}
