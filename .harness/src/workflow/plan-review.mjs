import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { assertActiveReviewAdmission, updateReviewAttempt, inspectActiveReviewAttempt, inspectReviewHistory } from './review-attempts.mjs';
import { normalizeReviewContent, reviewDelta } from './review-delta.mjs';
import { sessionDirectory, sessionOutputPath, stageExecutionPaths } from './session-output.mjs';
import { readSkillSessionJson } from './skill-execution.mjs';
import { parseWorktreeRecord, resolveExecutionWorkspace } from './worktrees.mjs';
import { parseYaml } from '../eval/yaml.mjs';
import { renderPublicationBodies, writePublicationBodies } from '../tracker/publication-body.mjs';
import { LEGACY_TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_DOCUMENT } from './worktree-stages.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error(message); }
export const planReviewSnapshotHash = (inputs) => hash(JSON.stringify(Object.keys(inputs).sort().map((key) => [key, inputs[key]])));

async function readPlanIssueDrafts({ root, plans }) {
  const config = await readFile(join(root, '.harness/harness.yaml'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (parseYaml(config).tracker?.mode !== 'github') return { drafts: [], missing: [] };
  requireValue(!plans.some((plan) => plan.id === 'parent'), 'The plan ID parent is reserved for the GitHub plan-set draft');
  const drafts = [];
  const missing = [];
  for (const planId of ['@parent', ...plans.map((plan) => plan.id)]) {
    const path = `.io/runtime/to-ticket/drafts/${planId === '@parent' ? 'parent' : planId}.md`;
    sessionOutputPath(root, path.slice('.io/'.length), { create: false });
    const file = await safeFile(root, path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const body = file?.content.toString('utf8');
    requireValue(!file || Buffer.from(body).equals(file.content), `GitHub Issue draft must be UTF-8: ${path}`);
    if (!body?.trim()) missing.push(path);
    else drafts.push({ plan_id: planId, path, body, sha256: file.sha256 });
  }
  return { drafts, missing };
}

function requirePlanIssueDrafts(missing) {
  requireValue(!missing.length, `to-ticket must save a GitHub Issue draft for the plan set and every plan in the session directory before completing; missing or empty: ${missing.join(', ')}`);
}

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

// A plan set is reviewed against the documents the tactical flow settled: the fixed requirements, the tactical design
// (`tactical-design.md`, or the legacy name an earlier Harness gave it), the project glossary and context map, and the
// technology, UI handoff, API and data decisions. Whichever of them exist are the review basis; nothing here needs a
// Product or Architecture Spec.
const DECISION_DOCUMENTS = ['technology', 'ui-handoff', 'api', 'data'];
export const planDesignCandidates = (planSetId) => [
  `docs/specs/${planSetId}/requirements.md`,
  `docs/specs/${planSetId}/${TACTICAL_DESIGN_DOCUMENT}`,
  `docs/specs/${planSetId}/${LEGACY_TACTICAL_DESIGN_DOCUMENT}`,
  'CONTEXT.md',
  'CONTEXT-MAP.md',
  '.codex/context-budget.json',
  ...DECISION_DOCUMENTS.map((name) => `docs/implementation/${planSetId}/${name}.md`),
];
// Specs of a plan set that predates the tactical flow stay in its review basis when they exist, so that plan set keeps a
// current review. They are never required and the current flow never writes them.
const legacySpecPaths = (planSetId) => [`docs/specs/${planSetId}/product-spec.md`, `docs/specs/${planSetId}/architecture-spec.md`];
const exists = (root, path) => safeFile(root, path).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));

export async function planDesignPaths({ root, planSetId }) {
  requireValue(ID.test(planSetId || ''), 'Valid plan-set ID is required');
  const paths = [];
  for (const path of planDesignCandidates(planSetId)) if (await exists(root, path)) paths.push(path);
  return paths;
}

const citationTokens = (text) => text.match(/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/g) || [];

async function citedDecisionFiles({ root, documents }) {
  const tokens = new Set(documents.flatMap(citationTokens));
  const files = new Map();
  for (const [directory, extension] of [['docs/adr', '.md'], ['knowledge/claims', '.yaml'], ['knowledge/evidence', '.yaml']]) {
    await assertWorkspaceTarget(root, directory);
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(extension) || (!tokens.has(entry.name) && !tokens.has(entry.name.slice(0, -extension.length)))) continue;
      const path = `${directory}/${entry.name}`;
      const file = await safeFile(root, path);
      files.set(path, file);
      if (directory === 'docs/adr') {
        for (const token of citationTokens(file.content.toString('utf8'))) tokens.add(token);
      }
      if (directory === 'knowledge/claims') {
        const source = parseYaml(file.content.toString('utf8')).source_id;
        if (ID.test(source || '')) {
          const sourcePath = `knowledge/sources/${source}.yaml`;
          files.set(sourcePath, await safeFile(root, sourcePath));
        }
      }
    }
  }
  return files;
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
  const designPaths = await planDesignPaths({ root, planSetId });
  const session = sessionDirectory(root, { create: false });
  const readOptionalState = async (path) => {
    try { await lstat(join(session, path)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return readSkillSessionJson({ root, session_directory: session, path });
  };
  const workflow = await readOptionalState('runtime/orchestrator/workflow.json');
  const state = workflow?.state || await readOptionalState('runtime/orchestrator/state.json');
  const ui = state?.stages?.['tactical-ui'];
  if (ui?.status === 'completed' && ui.code === 'OK' && ui.result_ref) {
    const result = await readSkillSessionJson({ root, session_directory: session, path: ui.result_ref });
    for (const artifact of result.artifacts.filter((item) => item.base === 'session' && item.kind === 'frontend_design_brief')) {
      const path = `.io/${artifact.path}`;
      const file = await safeFile(root, path);
      requireValue(file.sha256 === artifact.sha256, 'Frontend design brief changed after tactical-ui completed');
      designPaths.push(path);
    }
  }
  const specPaths = (await Promise.all(legacySpecPaths(planSetId).map((path) => exists(root, path)))).every(Boolean) ? legacySpecPaths(planSetId) : [];
  const plans = await discoverPlans({ root, base });
  requireValue(plans.length > 0, 'Plan set has no split plans');
  requireValue(designPaths.some((path) => path !== '.codex/context-budget.json') || specPaths.length, `Plan set has no design basis: expected the tactical flow's documents (docs/specs/${planSetId}/tactical-design.md, docs/implementation/${planSetId}/*.md)`);

  const inputs = { [`${base}/plans.md`]: indexFile.sha256 };
  const documents = [indexFile.content.toString('utf8'), ...plans.map((plan) => plan.body)];
  for (const path of [...designPaths, ...specPaths]) {
    const file = await safeFile(root, path);
    inputs[path] = file.sha256;
    documents.push(file.content.toString('utf8'));
  }
  for (const plan of plans) {
    const key = plan.path || `${base}/plans/${plan.id}#canonical`;
    inputs[key] = plan.sha256;
  }
  for (const [path, file] of await citedDecisionFiles({ root, documents })) inputs[path] = file.sha256;
  const { drafts, missing } = await readPlanIssueDrafts({ root, plans });
  for (const draft of drafts) inputs[draft.path] = draft.sha256;
  const publicationBodies = missing.length ? [] : renderPublicationBodies({
    planSetId, base, indexBody: indexFile.content.toString('utf8'), plans, issueDrafts: drafts, workspace: executionWorkspace,
  });
  for (const body of publicationBodies) inputs[`.io/${body.body_path}`] = body.body_sha256;
  return { plan_set_id: planSetId, base, design_paths: designPaths, spec_paths: specPaths, plans, inputs, publication_bodies: publicationBodies, missing_issue_drafts: missing, execution_workspace: executionWorkspace };
}

export async function assertDispatchPlanReview({ root, planSetId, planId, expectedSnapshotSha256 }) {
  const review = await inspectPlanSet({ root, planSetId, phase: 'dispatch', planId, expectedSnapshotSha256 });
  requireValue(review.status === 'pass', `Plan review dispatch refused for ${planId}: ${review.reason}`);
  return review.details;
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
    const previousInputs = await reviewAdmissionPreviousInputs({ root: historyRoot, scope: `plan-${planSetId}`, attemptId: admission.attempt_id });
    requireValue(JSON.stringify(admission.previous_inputs) === JSON.stringify(previousInputs), 'Plan review delta baseline does not match history');
    requireValue(JSON.stringify(admission.review_delta) === JSON.stringify(await reviewDelta({ root, inputs, previousInputs })), 'Plan review delta does not match admitted inputs');
  }
  return admission;
}

export async function readPlanReviewerAdmission({ root, planSetId, attempt, executionId = attempt.admission_execution_id }) {
  requireValue(attempt.admission_ref && attempt.admission_execution_id === executionId, 'Plan review attempt has no runner-owned admission for this execution');
  const bytes = await readFile(sessionOutputPath(root, attempt.admission_ref, { create: false }));
  requireValue(!attempt.admission_sha256 || hash(bytes) === attempt.admission_sha256, 'Plan review admission changed after the runner bound it');
  const admitted = JSON.parse(bytes);
  requireValue(admitted.schema_version === 1 && admitted.attempt_id === attempt.attempt_id && admitted.plan_set_id === planSetId && admitted.execution_id === executionId && JSON.stringify(admitted.inputs) === JSON.stringify(attempt.inputs), 'Plan review does not match its runner-owned admission');
  requireValue(Array.isArray(admitted.files) && admitted.files.length === Object.keys(attempt.inputs).length && new Set(admitted.files.map((file) => file.path)).size === admitted.files.length && admitted.files.every((file) => {
    if (attempt.inputs[file.path] !== file.sha256 || typeof file.content !== 'string' || !['raw-v1', 'frontmatter-status-excluded-v1'].includes(file.normalization)) return false;
    const content = Buffer.from(file.content);
    return hash(file.normalization === 'frontmatter-status-excluded-v1' ? normalizeReviewContent(file.path, content) : content) === file.sha256;
  }), 'Plan review admission contents do not match its snapshot');
  return admitted;
}

export async function inspectPlanSet({ root, planSetId, phase, planId, expectedSnapshotSha256 } = {}) {
  try {
    requireValue(['planning', 'dispatch', 'completion'].includes(phase), 'Valid plan-set phase is required');
    const snapshot = await snapshotPlanSet({ root, planSetId });
    requirePlanIssueDrafts(snapshot.missing_issue_drafts);
    const history = await inspectReviewHistory({ root, scope: `plan-${planSetId}` });
    const review = history.last_review;
    requireValue(history.recorded_state === 'pass' && review?.verdict === 'pass', 'Fresh independent plan review is missing or not passing');
    requireValue(Object.keys(snapshot.inputs).length === Object.keys(review.inputs || {}).length && Object.entries(snapshot.inputs).every(([path, digest]) => review.inputs[path] === digest), 'Plan review is stale; review changed sections and affected relationships with a fresh reviewer');
    const snapshotSha256 = planReviewSnapshotHash(snapshot.inputs);
    requireValue(expectedSnapshotSha256 === undefined || expectedSnapshotSha256 === snapshotSha256, 'Plan review no longer matches the snapshot recorded when to-ticket finished');
    if (phase === 'dispatch' || (phase === 'completion' && planId)) requireValue(snapshot.plans.some((plan) => plan.id === planId), `Plan ${planId || '(missing)'} is not in the reviewed plan set`);
    const selected = planId ? snapshot.plans.find((plan) => plan.id === planId) : null;
    const currentRequirementsPath = `docs/specs/${planSetId}/requirements.md`;
    const currentTacticalPath = `docs/specs/${planSetId}/${TACTICAL_DESIGN_DOCUMENT}`;
    const legacyTacticalPath = `docs/specs/${planSetId}/${LEGACY_TACTICAL_DESIGN_DOCUMENT}`;
    const currentTacticalDesignPath = snapshot.design_paths.includes(currentTacticalPath)
      ? currentTacticalPath
      : snapshot.design_paths.includes(legacyTacticalPath) ? legacyTacticalPath : null;
    const hasCurrentReviewBasis = snapshot.design_paths.includes(currentRequirementsPath) && currentTacticalDesignPath;
    const hasLegacyReviewBasis = snapshot.spec_paths.length === 2;
    requireValue(hasCurrentReviewBasis || hasLegacyReviewBasis, `Plan set review requires requirements.md with tactical-design.md (or a complete legacy Product/Architecture Spec pair) under docs/specs/${planSetId}`);
    const requirementsPath = hasCurrentReviewBasis ? currentRequirementsPath : snapshot.spec_paths[0];
    const tacticalDesignPath = hasCurrentReviewBasis ? currentTacticalDesignPath : snapshot.spec_paths[1];
    const canonicalBody = selected?.body || '';
    const canonicalKey = selected?.path || `${snapshot.base}/plans/${selected?.id}#canonical`;
    return { status: 'pass', reason: `plan_set_${phase}_current`, violations: [], details: {
      review_snapshot_sha256: snapshotSha256,
      review_attempt_id: history.last_attempt_id,
      execution_workspace: snapshot.execution_workspace,
      plan_set_id: planSetId, ticket_id: planSetId, design_paths: snapshot.design_paths, spec_paths: snapshot.spec_paths, plan_ids: snapshot.plans.map((plan) => plan.id),
      plan_id: planId || null, plan_reference: selected?.path || selected?.reference || null,
      requirements_path: requirementsPath,
      tactical_design_path: tacticalDesignPath,
      // Keep the v1 review-input keys while old session artifacts are still resumable. Their values point at the
      // current requirements/tactical design documents for current-flow plan sets.
      product_spec_path: requirementsPath,
      architecture_spec_path: tacticalDesignPath,
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
    const publicationPath = /^\.io\/runtime\/to-ticket\/(?:drafts|publication-bodies)\/(.+)\.md$/;
    const sharedChanged = changed_paths.some((path) => path === `${snapshot.base}/plans.md` || publicationPath.exec(path)?.[1] === 'parent'
      || (!path.startsWith(`${snapshot.base}/`) && !publicationPath.test(path)));
    const publicationChanges = new Set(changed_paths.map((path) => publicationPath.exec(path)?.[1]));
    const affected_plan_ids = snapshot.plans.filter((plan) => sharedChanged || changed_paths.includes(plan.path) || publicationChanges.has(plan.id)).map((plan) => plan.id);
    return { status: 'pass', plan_set_id: planSetId, changed_paths, affected_plan_ids, revalidation: changed_paths.length ? 'Review changed sections and directly affected relationships with a fresh independent reviewer.' : 'No changed review inputs.' };
  } catch (error) { return { status: 'blocked', reason: error.message, plan_set_id: planSetId }; }
}

async function mainSessionExecutionId(root) {
  if (process.cwd() !== root) return null;
  const { currentStageExecutionId } = await import('./native-context.mjs');
  return currentStageExecutionId(root, { awaitingReviewFrom: 'to-ticket' });
}

export async function updatePlanReview({ root, planSetId, action, attemptId, review, reason, requireNative = false }) {
  const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotPlanSet({ root, planSetId });
  if (action === 'begin') requirePlanIssueDrafts(snapshot.missing_issue_drafts);
  let reviewer_input_ref;
  let reviewerFiles;
  let executionId;
  if (action === 'begin') {
    // When the stage cannot start the reviewer, its caller (the main session) opens the admission for the current stage
    // execution: the stage returned REVIEW_REQUIRED and is waiting for this review.
    executionId = process.env.HARNESS_SKILL_EXECUTION_ID || await mainSessionExecutionId(root);
    requireValue((process.env.HARNESS_SKILL_EXECUTION_ID ? process.env.HARNESS_WORKSPACE_ROOT === root : Boolean(executionId)) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || ''), 'Plan review admission requires its runner workspace and execution identity');
    const rendered = new Map(snapshot.publication_bodies.map((body) => [`.io/${body.body_path}`, body]));
    reviewerFiles = [];
    for (const path of Object.keys(snapshot.inputs)) {
      const publication = rendered.get(path);
      if (publication) {
        reviewerFiles.push({ path, sha256: publication.body_sha256, normalization: 'raw-v1', content: publication.body });
        continue;
      }
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
    requireValue(active.attempt_id === attemptId, 'Plan review cannot record a different attempt');
    await readPlanReviewerAdmission({ root, planSetId, attempt: active });
  }
  const result = await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action, inputs: snapshot?.inputs, attemptId, review, reason, requireNative });
  if (action === 'begin' && result.reason !== 'recovered_pass') {
    const ref = `runtime/executions/${executionId}/plan-review-admission-${result.attempt_id}.json`;
    try {
      await writePublicationBodies(root, snapshot.publication_bodies);
      result.review_delta = await reviewDelta({ root, inputs: result.inputs, previousInputs: result.previous_inputs });
      const { directory } = stageExecutionPaths(root, executionId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const admission = { schema_version: 1, status: 'pass', execution_id: executionId, attempt_id: result.attempt_id, plan_set_id: planSetId, inputs: snapshot.inputs, files: reviewerFiles, previous_inputs: result.previous_inputs, previous_findings: result.previous_findings, review_delta: result.review_delta };
      const bytes = `${JSON.stringify(admission, null, 2)}\n`;
      await writeFile(join(directory, `plan-review-admission-${result.attempt_id}.json`), bytes, { flag: 'wx', mode: 0o600 });
      await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action: 'bind-admission', attemptId: result.attempt_id, executionId, admissionRef: ref, admissionSha256: hash(bytes) });
    } catch (error) {
      await updateReviewAttempt({ root, scope: `plan-${planSetId}`, action: 'abort', attemptId: result.attempt_id, reason: `pre-dispatch preparation: could not persist reviewer admission: ${error.message}` });
      throw error;
    }
    reviewer_input_ref = ref;
  }
  return { ...result, ...(reviewer_input_ref ? { reviewer_input_ref } : {}) };
}
