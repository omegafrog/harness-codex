import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertActiveReviewAdmission, updateReviewAttempt, inspectReviewHistory } from './review-attempts.mjs';
import { sessionDirectory } from './session-output.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error(message); }
const normalizePlanBody = (body) => body.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, (frontmatter) => frontmatter.replace(/^status:\s*[^\r\n]+\r?\n/gm, ''));
export function validateCanonicalPlanReference(reference) {
  requireValue(reference?.kind === 'file', 'Canonical plan must be a workspace file');
  requireValue(typeof reference.reference === 'string' && reference.reference, 'Canonical plan reference is required');
  requireValue(reference.hash_algorithm === 'sha256' && reference.normalization === 'frontmatter-status-excluded-v1' && /^[a-f0-9]{64}$/.test(reference.sha256 || ''), 'Canonical plan hash metadata is invalid');
  requireValue(typeof reference.input_key === 'string' && reference.input_key.endsWith('#canonical'), 'Canonical plan input key is invalid');
  requireValue(!isAbsolute(reference.reference) && !reference.reference.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') && !reference.reference.includes('#'), 'Canonical plan file must be workspace-relative');
}

async function safeFile(root, path) {
  requireValue(typeof path === 'string' && path && !path.startsWith('/') && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), `Invalid workspace-relative path: ${path}`);
  await assertWorkspaceTarget(root, path);
  const info = await lstat(join(root, path));
  requireValue(info.isFile() && !info.isSymbolicLink(), `Expected a regular non-symlink file: ${path}`);
  const content = await readFile(join(root, path));
  return { content, sha256: hash(content) };
}

function specPathsFromIndex(index, base, planSetId) {
  const found = {};
  for (const line of index.split(/\r?\n/)) {
    const kind = /product\s+spec/i.test(line) ? 'product' : /architecture\s+spec/i.test(line) ? 'architecture' : null;
    if (!kind) continue;
    const raw = line.match(/`([^`]+\.md)`/)?.[1] || line.match(/\]\(([^)]+\.md)\)/)?.[1];
    if (!raw || /^https?:/i.test(raw)) continue;
    const path = posix.normalize(raw.startsWith('docs/') ? raw : posix.join(base, raw));
    requireValue(!path.startsWith('../') && !isAbsolute(path), `Spec path escapes workspace: ${raw}`);
    found[kind] = path;
  }
  found.product ||= `docs/specs/${planSetId}/product-spec.md`;
  found.architecture ||= `docs/specs/${planSetId}/architecture-spec.md`;
  requireValue(found.product !== found.architecture, 'Product and Architecture Spec paths must differ');
  return [found.product, found.architecture];
}

async function discoverPlans({ root, base }) {
  const entries = await readdir(join(root, base), { withFileTypes: true });
  const plans = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'plans.md') continue;
    const id = entry.name.slice(0, -3);
    requireValue(ID.test(id), `Invalid canonical plan filename: ${entry.name}`);
    const path = `${base}/${entry.name}`;
    const file = await safeFile(root, path);
    plans.push({ id, path, body: file.content.toString('utf8'), sha256: hash(file.content) });
  }
  if (plans.length) return plans.sort((a, b) => a.id.localeCompare(b.id));

  throw new Error(`No canonical plan documents found under ${base}`);
}

export async function snapshotPlanSet({ root, planSetId } = {}) {
  requireValue(ID.test(planSetId || ''), 'Valid plan-set ID is required');
  try {
    const record = parseWorktreeRecord(await readFile(join(sessionDirectory(root, { create: false }), 'worktree.json'), 'utf8'));
    requireValue(record.plan_set_id === planSetId, `plan_set_id mismatch: worktree.json has ${record.plan_set_id || '(unset)'}, requested ${planSetId}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const base = `docs/plans/${planSetId}`;
  const indexFile = await safeFile(root, `${base}/plans.md`);
  const index = indexFile.content.toString('utf8');
  const specPaths = specPathsFromIndex(index, base, planSetId);
  const plans = await discoverPlans({ root, base });
  requireValue(plans.length > 0, 'Plan set has no split plans');

  const inputs = { [`${base}/plans.md`]: indexFile.sha256 };
  for (const path of specPaths) inputs[path] = (await safeFile(root, path)).sha256;
  for (const path of [
    `docs/specs/${planSetId}/request.md`, `docs/specs/${planSetId}/system-targets.yaml`,
    `docs/specs/${planSetId}/system-targets.md`, 'CONTEXT.md', 'CONTEXT-MAP.md',
    'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/agents/execution.json',
  ]) {
    try { inputs[path] = (await safeFile(root, path)).sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const plan of plans) {
    const key = plan.path || `${base}/plans/${plan.id}#canonical`;
    inputs[key] = plan.sha256;
  }
  return { plan_set_id: planSetId, base, spec_paths: specPaths, plans, inputs };
}

async function reviewHistoryRoot(root) {
  try {
    const record = parseWorktreeRecord(await readFile(join(sessionDirectory(root, { create: false }), 'worktree.json'), 'utf8'));
    return record.return_root;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return root; }
}

export async function validatePlanReviewAdmission({ root, planSetId, admission, requireActive = true }) {
  requireValue(ID.test(planSetId || '') && admission?.status === 'pass' && typeof admission.attempt_id === 'string', 'Invalid plan review admission target');
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const inputs = admission.inputs;
  requireValue(inputs && Object.keys(snapshot.inputs).length === Object.keys(inputs).length && Object.entries(snapshot.inputs).every(([path, value]) => inputs[path] === value), 'Plan review admission snapshot is stale');
  const historyRoot = await reviewHistoryRoot(root);
  await assertActiveReviewAdmission({ root: historyRoot, scope: `plan-${planSetId}`, attemptId: admission.attempt_id, inputs, requireActive });
  if (admission.review_delta) {
    const { reviewAdmissionPreviousInputs } = await import('./review-attempts.mjs');
    const { reviewDelta } = await import('./review-delta.mjs');
    const previousInputs = await reviewAdmissionPreviousInputs({ root: historyRoot, scope: `plan-${planSetId}`, attemptId: admission.attempt_id });
    requireValue(JSON.stringify(admission.previous_inputs) === JSON.stringify(previousInputs), 'Plan review delta baseline does not match history');
    requireValue(JSON.stringify(admission.review_delta) === JSON.stringify(await reviewDelta({ root, inputs, previousInputs })), 'Plan review delta does not match admitted inputs');
  }
  return admission;
}


export async function inspectPlanSet({ root, planSetId, phase, planId } = {}) {
  try {
    requireValue(['planning', 'dispatch', 'completion'].includes(phase), 'Valid plan-set phase is required');
    const snapshot = await snapshotPlanSet({ root, planSetId });
    const history = await inspectReviewHistory({ root: await reviewHistoryRoot(root), scope: `plan-${planSetId}` });
    const review = history.last_review;
    requireValue(history.recorded_state === 'pass' && review?.verdict === 'pass', 'Fresh independent plan review is missing or not passing');
    requireValue(Object.keys(snapshot.inputs).length === Object.keys(review.inputs || {}).length && Object.entries(snapshot.inputs).every(([path, digest]) => review.inputs[path] === digest), 'Plan review is stale; review changed sections and affected relationships with a fresh reviewer');
    if (phase === 'dispatch' || (phase === 'completion' && planId)) requireValue(snapshot.plans.some((plan) => plan.id === planId), `Plan ${planId || '(missing)'} is not in the reviewed plan set`);
    const selected = planId ? snapshot.plans.find((plan) => plan.id === planId) : null;
    const canonicalBody = selected?.body || '';
    const canonicalKey = selected?.path || `${snapshot.base}/plans/${selected?.id}#canonical`;
    return { status: 'pass', reason: `plan_set_${phase}_current`, violations: [], details: {
      review_snapshot_sha256: hash(JSON.stringify(Object.keys(snapshot.inputs).sort().map((key) => [key, snapshot.inputs[key]]))),
      plan_set_id: planSetId, ticket_id: snapshot.spec_paths[0].split("/")[2], spec_paths: snapshot.spec_paths, plan_ids: snapshot.plans.map((plan) => plan.id),
      plan_id: planId || null, plan_reference: selected?.path || selected?.reference || null,
      product_spec_path: snapshot.spec_paths[0], architecture_spec_path: snapshot.spec_paths[1],
      canonical_plan: selected ? { kind: 'file', reference: selected.path, input_key: `${canonicalKey}#canonical`, hash_algorithm: 'sha256', normalization: 'frontmatter-status-excluded-v1', sha256: hash(normalizePlanBody(canonicalBody)) } : null,
    } };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['plan_review'] }; }
}


export async function inspectPlanSetImpact({ root, planSetId } = {}) {
  try {
    const snapshot = await snapshotPlanSet({ root, planSetId });
    const history = await inspectReviewHistory({ root: await reviewHistoryRoot(root), scope: `plan-${planSetId}` });
    const prior = history.last_review?.inputs || {};
    const changed_paths = [...new Set([...Object.keys(prior), ...Object.keys(snapshot.inputs)])].filter((path) => prior[path] !== snapshot.inputs[path]).sort();
    return { status: 'pass', plan_set_id: planSetId, changed_paths, affected_plan_ids: changed_paths.length ? snapshot.plans.map((plan) => plan.id) : [], revalidation: changed_paths.length ? 'Review changed sections and directly affected relationships with a fresh independent reviewer.' : 'No changed review inputs.' };
  } catch (error) { return { status: 'blocked', reason: error.message, plan_set_id: planSetId }; }
}

export async function updatePlanReview({ root, planSetId, action, attemptId, review, reason }) {
  const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotPlanSet({ root, planSetId });
  return updateReviewAttempt({ root: await reviewHistoryRoot(root), scope: `plan-${planSetId}`, action, inputs: snapshot?.inputs, attemptId, review, reason });
}
