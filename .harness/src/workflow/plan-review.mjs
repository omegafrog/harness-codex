import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertActiveReviewAdmission, updateReviewAttempt, inspectActiveReviewAttempt, inspectReviewHistory } from './review-attempts.mjs';
import { normalizeReviewContent } from './review-delta.mjs';
import { sessionDirectory, sessionOutputPath, stageExecutionPaths } from './session-output.mjs';
import { parseWorktreeRecord, resolveExecutionWorkspace } from './worktrees.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error(message); }
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
    // A line can mention a Spec and link other documents (EXEC.md, a plan); only a path that names that Spec counts.
    const candidates = [...line.matchAll(/`([^`]+\.md)`/g), ...line.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
    const raw = candidates.find((path) => new RegExp(`${kind}[^/]*\\.md$`, 'i').test(path));
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
    plans.push({ id, path, body: file.content.toString('utf8'), sha256: hash(normalizeReviewContent(path, file.content)) });
  }
  if (plans.length) return plans.sort((a, b) => a.id.localeCompare(b.id));

  throw new Error(`No canonical plan documents found under ${base}`);
}

export async function snapshotPlanSet({ root, planSetId } = {}) {
  requireValue(ID.test(planSetId || ''), 'Valid plan-set ID is required');
  let executionWorkspace = null;
  let worktreeText;
  try { worktreeText = await readFile(join(sessionDirectory(root, { create: false }), 'worktree.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (worktreeText !== undefined) {
    const record = parseWorktreeRecord(worktreeText);
    requireValue(record.plan_set_id === planSetId, `plan_set_id mismatch: worktree.json has ${record.plan_set_id || '(unset)'}, requested ${planSetId}`);
    executionWorkspace = await resolveExecutionWorkspace(root, planSetId);
  }
  const base = `docs/plans/${planSetId}`;
  const indexFile = await safeFile(root, `${base}/plans.md`);
  const index = indexFile.content.toString('utf8');
  // spec-me writes the Specs at fixed paths; those are the review inputs. The index is only read for older plan sets
  // whose Specs live elsewhere.
  const fixedSpecs = [`docs/specs/${planSetId}/product-spec.md`, `docs/specs/${planSetId}/architecture-spec.md`];
  const specPaths = (await Promise.all(fixedSpecs.map((path) => safeFile(root, path).then(() => true, () => false)))).every(Boolean) ? fixedSpecs : specPathsFromIndex(index, base, planSetId);
  const plans = await discoverPlans({ root, base });
  requireValue(plans.length > 0, 'Plan set has no split plans');

  const inputs = { [`${base}/plans.md`]: indexFile.sha256 };
  for (const path of specPaths) {
    const file = await safeFile(root, path);
    inputs[path] = file.sha256;
  }
  for (const plan of plans) {
    const key = plan.path || `${base}/plans/${plan.id}#canonical`;
    inputs[key] = plan.sha256;
  }
  return { plan_set_id: planSetId, base, spec_paths: specPaths, plans, inputs, execution_workspace: executionWorkspace };
}

export async function validatePlanReviewAdmission({ root, planSetId, admission, requireActive = true }) {
  requireValue(ID.test(planSetId || '') && admission?.status === 'pass' && typeof admission.attempt_id === 'string', 'Invalid plan review admission target');
  const snapshot = await snapshotPlanSet({ root, planSetId });
  const inputs = admission.inputs;
  requireValue(inputs && Object.keys(snapshot.inputs).length === Object.keys(inputs).length && Object.entries(snapshot.inputs).every(([path, value]) => inputs[path] === value), 'Plan review admission snapshot is stale');
  const historyRoot = root;
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
    const history = await inspectReviewHistory({ root, scope: `plan-${planSetId}` });
    const review = history.last_review;
    requireValue(history.recorded_state === 'pass' && review?.verdict === 'pass', 'Fresh independent plan review is missing or not passing');
    requireValue(Object.keys(snapshot.inputs).length === Object.keys(review.inputs || {}).length && Object.entries(snapshot.inputs).every(([path, digest]) => review.inputs[path] === digest), 'Plan review is stale; review changed sections and affected relationships with a fresh reviewer');
    if (phase === 'dispatch' || (phase === 'completion' && planId)) requireValue(snapshot.plans.some((plan) => plan.id === planId), `Plan ${planId || '(missing)'} is not in the reviewed plan set`);
    const selected = planId ? snapshot.plans.find((plan) => plan.id === planId) : null;
    const canonicalBody = selected?.body || '';
    const canonicalKey = selected?.path || `${snapshot.base}/plans/${selected?.id}#canonical`;
    return { status: 'pass', reason: `plan_set_${phase}_current`, violations: [], details: {
      review_snapshot_sha256: hash(JSON.stringify(Object.keys(snapshot.inputs).sort().map((key) => [key, snapshot.inputs[key]]))),
      review_attempt_id: review.attempt_id,
      execution_workspace: snapshot.execution_workspace,
      plan_set_id: planSetId, ticket_id: snapshot.spec_paths[0].split("/")[2], spec_paths: snapshot.spec_paths, plan_ids: snapshot.plans.map((plan) => plan.id),
      plan_id: planId || null, plan_reference: selected?.path || selected?.reference || null,
      product_spec_path: snapshot.spec_paths[0], architecture_spec_path: snapshot.spec_paths[1],
      canonical_plan: selected ? { kind: 'file', reference: selected.path, input_key: `${canonicalKey}#canonical`, hash_algorithm: 'sha256', normalization: 'frontmatter-status-excluded-v1', sha256: hash(normalizeReviewContent(selected.path, Buffer.from(canonicalBody))) } : null,
    } };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['plan_review'] }; }
}


export async function inspectPlanSetImpact({ root, planSetId } = {}) {
  try {
    const snapshot = await snapshotPlanSet({ root, planSetId });
    const history = await inspectReviewHistory({ root, scope: `plan-${planSetId}` });
    const prior = history.last_review?.inputs || {};
    const changed_paths = [...new Set([...Object.keys(prior), ...Object.keys(snapshot.inputs)])].filter((path) => prior[path] !== snapshot.inputs[path]).sort();
    const changedPlans = snapshot.plans.filter((plan) => changed_paths.includes(plan.path)).map((plan) => plan.id);
    const specificationChanged = changed_paths.some((path) => path.startsWith('docs/specs/') || path === 'CONTEXT.md' || path === 'CONTEXT-MAP.md' || path.startsWith('docs/contracts/'));
    const affected_plan_ids = specificationChanged ? snapshot.plans.map((plan) => plan.id) : changedPlans;
    return { status: 'pass', plan_set_id: planSetId, changed_paths, affected_plan_ids, revalidation: changed_paths.length ? 'Review changed sections and directly affected relationships with a fresh independent reviewer.' : 'No changed review inputs.' };
  } catch (error) { return { status: 'blocked', reason: error.message, plan_set_id: planSetId }; }
}

export async function updatePlanReview({ root, planSetId, action, attemptId, review, reason, requireNative = false }) {
  const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotPlanSet({ root, planSetId });
  let reviewer_input_ref;
  let reviewerFiles;
  if (action === 'begin') {
    const executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
    requireValue(process.env.HARNESS_WORKSPACE_ROOT === root && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || ''), 'Plan review admission requires its runner workspace and execution identity');
    reviewerFiles = [];
    for (const path of Object.keys(snapshot.inputs)) {
      const file = await safeFile(root, path);
      const plan = snapshot.plans.find((item) => item.path === path);
      const capturedHash = plan ? hash(normalizeReviewContent(path, file.content)) : hash(file.content);
      requireValue(capturedHash === snapshot.inputs[path], `Plan review input changed while preparing its admission: ${path}`);
      reviewerFiles.push({ path, sha256: capturedHash, normalization: plan ? 'frontmatter-status-excluded-v1' : 'raw-v1', content: file.content.toString('utf8') });
    }
  }
  // Inside a stage, both providers bind the reviewer through the subagent hook before a record is accepted.
  if (action === 'record' && process.env.HARNESS_SKILL_EXECUTION_ID) {
    const executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
    requireValue(process.env.HARNESS_WORKSPACE_ROOT === root && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || ''), 'Plan review requires its runtime workspace and execution identity');
    const active = await inspectActiveReviewAttempt({ root, scope: `plan-${planSetId}` });
    const native = active.native_review;
    requireValue(active.attempt_id === attemptId && native?.execution_id === active.admission_execution_id && native.agent_id && native.stopped, 'Plan review record requires a stopped native reviewer bound to this admission by the subagent hook');
  }
  if (action === 'record') {
    const active = await inspectActiveReviewAttempt({ root, scope: `plan-${planSetId}` });
    requireValue(active.admission_ref && active.attempt_id === attemptId, 'Plan review attempt has no runner-owned admission file');
    const admitted = JSON.parse(await readFile(sessionOutputPath(root, active.admission_ref, { create: false }), 'utf8'));
    requireValue(admitted.attempt_id === attemptId && admitted.plan_set_id === planSetId && admitted.execution_id === active.admission_execution_id && JSON.stringify(admitted.inputs) === JSON.stringify(active.inputs), 'Recorded plan review does not match its runner-owned admission');
    requireValue(Array.isArray(admitted.files) && admitted.files.length === Object.keys(active.inputs).length && new Set(admitted.files.map((file) => file.path)).size === admitted.files.length && admitted.files.every((file) => {
      if (active.inputs[file.path] !== file.sha256 || typeof file.content !== 'string' || !['raw-v1', 'frontmatter-status-excluded-v1'].includes(file.normalization)) return false;
      const content = Buffer.from(file.content);
      return hash(file.normalization === 'frontmatter-status-excluded-v1' ? normalizeReviewContent(file.path, content) : content) === file.sha256;
    }), 'Plan review admission contents do not match its snapshot');
  }
  const result = await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action, inputs: snapshot?.inputs, attemptId, review, reason, requireNative });
  if (action === 'begin') {
    const executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
    if (executionId) {
      const ref = `runtime/executions/${executionId}/plan-review-admission-${result.attempt_id}.json`;
      try {
        const { directory } = stageExecutionPaths(root, executionId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, `plan-review-admission-${result.attempt_id}.json`), `${JSON.stringify({ schema_version: 1, execution_id: executionId, attempt_id: result.attempt_id, plan_set_id: planSetId, inputs: snapshot.inputs, files: reviewerFiles, previous_inputs: result.previous_inputs, previous_findings: result.previous_findings }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action: 'bind-admission', attemptId: result.attempt_id, executionId, admissionRef: ref });
      } catch (error) {
        await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action: 'abort', attemptId: result.attempt_id, reason: `pre-dispatch preparation: could not persist reviewer admission: ${error.message}` });
        throw error;
      }
      reviewer_input_ref = ref;
    }
  }
  return { ...result, ...(reviewer_input_ref ? { reviewer_input_ref } : {}) };
}
