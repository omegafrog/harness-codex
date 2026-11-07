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
const SCOPED_RULE = /\d|최대|최소|이상|이하|초과|미만|길이|형식|검증|삭제.*(?:모든|함께|동반)|(?:모든|함께|동반).*삭제/;
const RULE_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(BR-\d+)\b/;

const INTENT_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(INT-[A-Z0-9-]+)\b/;
const blockAfter = (lines, index) => {
  const block = [];
  for (const next of lines.slice(index + 1)) {
    if (RULE_LINE.test(next) || INTENT_LINE.test(next) || /^#{1,6}\s|^\d+\.\s/.test(next)) break;
    block.push(next);
  }
  return block.join('\n');
};
const fieldIssue = (id, block, fields) => {
  if (fields.some((field) => !new RegExp(`${field}\\s*:`).test(block))) return `${id}: ${fields.join(', ')} 필요`;
  return /출처\s*:\s*.*추정/.test(block) ? `${id}: 추정 출처는 사용자 승인 필요` : null;
};

// 의도가 있어야 구현과 리뷰가 "없으면 무엇이 깨지는가"로 판정하고 규칙을 임의로 강화하지 않는다.
export function intentIssues(markdown) {
  const lines = markdown.split('\n');
  const issues = [];
  let hasRule = false, hasIntent = false;
  lines.forEach((line, index) => {
    const intent = line.match(INTENT_LINE)?.[1];
    if (intent) {
      hasIntent = true;
      const issue = fieldIssue(intent, blockAfter(lines, index), ['목적', '충분한 수준', '출처']);
      if (issue) issues.push(issue);
      return;
    }
    const id = line.match(RULE_LINE)?.[1];
    if (!id) return;
    hasRule = true;
    if (!SCOPED_RULE.test(line.replace(/\b[A-Z]+-\d+\b/g, ''))) return;
    const issue = fieldIssue(id, blockAfter(lines, index), ['의도', '충분한 수준', '출처']);
    if (issue) issues.push(issue);
  });
  if (hasRule && !hasIntent) issues.unshift('제품 의도 INT-* 필요');
  return issues;
}

// 위임은 라우팅 표현이 아니라 사용자가 실제로 답한 기록이 있어야 한다.
export function decisionsWithoutDelegation(markdown) {
  return markdown.split('\n')
    .filter((line) => line.trim().startsWith('|') && line.includes('위임') && !line.includes('위임 없음') && !line.includes('answers.json'))
    .map((line) => line.split('|')[1]?.trim() || line.trim());
}

async function assertSpecDiscipline(root, ticketId) {
  const issues = intentIssues(await readFile(join(root, `docs/specs/${ticketId}/product-spec.md`), 'utf8'));
  requireValue(!issues.length, `Product Spec intent is incomplete (use 미확인 when the user has not said): ${issues.join('; ')}`);
  const decisions = await readFile(join(root, `docs/specs/${ticketId}/product-decisions.md`), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const unbacked = decisionsWithoutDelegation(decisions);
  requireValue(!unbacked.length, `Delegated product decisions need a recorded answers.json source; ask the user instead: ${unbacked.join(', ')}`);
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
    await assertSpecDiscipline(root, ticketId);
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
