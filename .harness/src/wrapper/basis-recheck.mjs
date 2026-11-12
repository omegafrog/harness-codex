import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { snapshotPlanSet } from '../workflow/plan-review.mjs';
import { normalizeReviewContent } from '../workflow/review-delta.mjs';

const git = promisify(execFile);
const gitRun = (root, args) => git('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const snapshotHash = (inputs) => hash(JSON.stringify(Object.keys(inputs).sort().map((key) => [key, inputs[key]])));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const recheckKey = (finding) => hash(JSON.stringify([finding.reviewer_role, finding.finding_index, finding.id])).slice(0, 12);

async function untrackedSnapshots(root) {
  const output = (await gitRun(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
  const snapshots = {};
  for (const path of output.split('\0').filter((item) => item && item !== '.io' && !item.startsWith('.io/'))) {
    const info = await lstat(`${root}/${path}`);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Cannot snapshot untracked non-file implementation path: ${path}`);
    const bytes = await readFile(`${root}/${path}`);
    snapshots[path] = { sha256: hash(bytes), content: bytes.toString('utf8') };
  }
  return snapshots;
}

export async function prepareBasisRecheck({ root, planId, reviewInput, finding }) {
  const planSetId = reviewInput?.plan_set_id;
  if (!planSetId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding?.id || '') || !finding.basis) throw new Error('Basis recheck needs the original finding and reviewed plan snapshot');
  const history = await readJson(sessionOutputPath(root, `runtime/reviews/plan-${planSetId}.json`, { create: false }));
  const attempt = history.attempts?.findLast((item) => item.status === 'pass' && item.review?.verdict === 'pass' && snapshotHash(item.inputs || {}) === reviewInput.planning_snapshot_sha256);
  if (!attempt?.admission_ref) throw new Error('Historical plan review snapshot is unavailable; do not reconstruct it');
  const admission = await readJson(sessionOutputPath(root, attempt.admission_ref, { create: false }));
  if (snapshotHash(admission.inputs || {}) !== reviewInput.planning_snapshot_sha256) throw new Error('Historical plan review admission does not match the implementation review snapshot');
  const reviewFiles = {};
  for (const file of admission.files || []) {
    const bytes = Buffer.from(file.content);
    const normalized = file.normalization === 'frontmatter-status-excluded-v1' ? normalizeReviewContent(file.path, bytes) : bytes;
    if (hash(normalized) !== file.sha256) throw new Error(`Historical snapshot content failed hash validation: ${file.path}`);
    reviewFiles[file.path] = { sha256: file.sha256, content: file.content };
  }
  const oldSpecs = [reviewInput.product_spec_path, reviewInput.architecture_spec_path];
  const oldPlan = reviewInput.canonical_plan?.reference;
  if (oldSpecs.some((path) => !reviewFiles[path]) || !oldPlan || !reviewFiles[oldPlan]) throw new Error('Historical Spec or canonical plan content is missing; do not invent a snapshot');
  if ([...oldSpecs, oldPlan].some((path) => admission.inputs[path] !== reviewFiles[path].sha256)
    || reviewFiles[oldPlan].sha256 !== reviewInput.canonical_plan.sha256) throw new Error('Historical Spec or plan hashes do not match the implementation review references');

  const current = await snapshotPlanSet({ root, planSetId });
  const currentFiles = {};
  for (const path of [...current.spec_paths, ...current.plans.map((item) => item.path)]) {
    const content = await readFile(`${root}/${path}`, 'utf8');
    const item = current.plans.find((plan) => plan.path === path);
    const normalized = item ? normalizeReviewContent(path, Buffer.from(content)) : Buffer.from(content);
    currentFiles[path] = { sha256: hash(normalized), content };
    if (current.inputs[path] !== currentFiles[path].sha256) throw new Error(`Current snapshot hash does not match the plan-set inputs: ${path}`);
  }
  const head = (await gitRun(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== reviewInput.implementation_commit_sha) throw new Error('Implementation HEAD no longer matches the code-review commit; run a fresh code review');
  const [currentCommittedDiff, currentIndexDiff, currentWorktreeDiff] = await Promise.all([
    gitRun(root, ['diff', `${reviewInput.fixed_point}..HEAD`]).then((result) => result.stdout),
    gitRun(root, ['diff', '--cached']).then((result) => result.stdout),
    gitRun(root, ['diff']).then((result) => result.stdout),
  ]);
  const currentUntrackedFiles = await untrackedSnapshots(root);
  const artifact = {
    schema_version: 1, finding_id: finding.id, plan_id: planId,
    review_time: { plan_set_id: planSetId, planning_snapshot_sha256: reviewInput.planning_snapshot_sha256, implementation_commit_sha: reviewInput.implementation_commit_sha, spec_paths: oldSpecs, canonical_plan_path: oldPlan, files: reviewFiles, implementation_diff: reviewInput.diff },
    current: { head, planning_snapshot_sha256: snapshotHash(current.inputs), plan_ids: current.plans.map((item) => item.id), implementation_commit_sha: head, implementation_diff: currentCommittedDiff, staged_diff: currentIndexDiff, worktree_diff: currentWorktreeDiff, untracked_files: currentUntrackedFiles, files: currentFiles },
    finding,
  };
  const ref = `runtime/reviews/implementation-${planId}-basis-${recheckKey(finding)}.json`;
  const path = sessionOutputPath(root, ref);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  return ref;
}

const ROUTE = { supported_finding: 'implementation', plan_gap: 'to-ticket', spec_decision: 'spec-me', unsupported_finding: 'dismiss', insufficient_evidence: 'blocked' };
export async function recordBasisRecheck({ root, planId, artifactRef, result }) {
  const artifact = await readJson(sessionOutputPath(root, artifactRef, { create: false }));
  if (artifact.schema_version !== 1 || artifact.plan_id !== planId || !result || result.schema_version !== 1 || result.finding_id !== artifact.finding_id || result.source_plan_id !== planId || !Object.hasOwn(ROUTE, result.classification) || result.route !== ROUTE[result.classification] || !artifact.current.plan_ids.includes(result.affected_plan_id) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.evidence) || !result.evidence.length) throw new Error('Invalid basis-recheck result: classification, route, source/affected plans and evidence must match the prepared review');
  for (const item of result.evidence) {
    let text;
    if (item.snapshot === 'review_time' && item.path === 'implementation.diff') text = artifact.review_time.implementation_diff;
    else if (item.snapshot === 'current' && item.path === 'implementation.diff') text = artifact.current.implementation_diff;
    else if (item.snapshot === 'current' && item.path === 'implementation.staged_diff') text = artifact.current.staged_diff;
    else if (item.snapshot === 'current' && item.path === 'implementation.worktree_diff') text = artifact.current.worktree_diff;
    else if (item.snapshot === 'current' && item.path.startsWith('implementation.untracked/')) text = artifact.current.untracked_files[item.path.slice('implementation.untracked/'.length)]?.content;
    else text = (item.snapshot === 'review_time' ? artifact.review_time.files : item.snapshot === 'current' ? artifact.current.files : {})[item.path]?.content;
    if (typeof text !== 'string' || typeof item.quote !== 'string' || !item.quote.trim() || !text.includes(item.quote) || typeof item.analysis !== 'string' || !item.analysis.trim()) throw new Error('Basis-recheck evidence must explain and quote a captured review-time or current snapshot');
  }
  const hasSourceEvidence = (result) => result.evidence.some((item) => !item.path.startsWith('implementation.'));
  const hasCurrentImplementationEvidence = (result) => result.evidence.some((item) => item.snapshot === 'current' && item.path.startsWith('implementation.'));
  if (result.classification === 'supported_finding' && (!hasSourceEvidence(result) || !hasCurrentImplementationEvidence(result))) throw new Error('Supporting an implementation finding requires current implementation and Spec/plan evidence');
  if (result.classification === 'plan_gap' && !result.evidence.some((item) => item.snapshot === 'current' && item.path === `docs/plans/${artifact.review_time.plan_set_id}/${result.affected_plan_id}.md`)) throw new Error('A plan-gap route must cite the affected current canonical plan');
  if (result.classification === 'spec_decision' && !result.evidence.some((item) => artifact.review_time.spec_paths.includes(item.path))) throw new Error('A Spec decision route must cite a reviewed Product or Architecture Spec');
  if (result.classification === 'unsupported_finding' && (!result.evidence.some((item) => item.snapshot === 'review_time') || !result.evidence.some((item) => item.snapshot === 'current'))) throw new Error('Dismissing a finding requires evidence from both review-time and current snapshots');
  const current = await snapshotPlanSet({ root, planSetId: artifact.review_time.plan_set_id });
  const currentHead = (await gitRun(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (currentHead !== artifact.current.head) throw new Error('Workspace HEAD changed during basis recheck; prepare a fresh review');
  const [staged, worktree] = await Promise.all([
    gitRun(root, ['diff', '--cached']).then((result) => result.stdout),
    gitRun(root, ['diff']).then((result) => result.stdout),
  ]);
  if (staged !== artifact.current.staged_diff || worktree !== artifact.current.worktree_diff) throw new Error('Implementation worktree changed during basis recheck');
  const untracked = await untrackedSnapshots(root);
  if (JSON.stringify(Object.keys(untracked).sort().map((path) => [path, untracked[path].sha256])) !== JSON.stringify(Object.keys(artifact.current.untracked_files).sort().map((path) => [path, artifact.current.untracked_files[path].sha256]))) throw new Error('Untracked implementation files changed during basis recheck');
  if (snapshotHash(current.inputs) !== artifact.current.planning_snapshot_sha256) throw new Error('Current plan-set snapshot changed during basis recheck');
  for (const [path, expected] of Object.entries(artifact.current.files)) {
    const plan = current.plans.find((item) => item.path === path);
    const content = await readFile(`${root}/${path}`, 'utf8');
    const actual = hash(plan ? normalizeReviewContent(path, Buffer.from(content)) : Buffer.from(content));
    if (actual !== expected.sha256) throw new Error(`Current review basis changed during recheck: ${path}`);
  }
  const ref = `runtime/reviews/implementation-${planId}-basis-result-${recheckKey(artifact.finding)}.json`;
  const recorded = { ...result, artifact_ref: artifactRef, finding_sha256: hash(JSON.stringify(artifact.finding)) };
  await writeFile(sessionOutputPath(root, ref), `${JSON.stringify(recorded, null, 2)}\n`, { mode: 0o600 });
  const evidenceRef = `runtime/reviews/implementation-${planId}-evidence.json`;
  const evidencePath = sessionOutputPath(root, evidenceRef, { create: false });
  const evidence = await readJson(evidencePath);
  const inReview = evidence.reviews?.some((review) => review.role === artifact.finding.reviewer_role && review.report?.findings?.[artifact.finding.finding_index]?.id === artifact.finding_id);
  if (!inReview) throw new Error('Basis recheck finding is not in the current implementation review evidence');
  evidence.basis_recheck_results = [...(evidence.basis_recheck_results || []).filter((item) => item.finding_sha256 !== recorded.finding_sha256), { finding_id: artifact.finding_id, finding_sha256: recorded.finding_sha256, result_ref: ref, artifact_ref: artifactRef }];
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return { status: 'pass', ...recorded, artifact_ref: artifactRef, evidence_ref: ref };
}

export async function verifiedBasisRecheckResults({ root, planId, findings, results = [] }) {
  const verified = [];
  for (const reference of results) {
    const result = await readJson(sessionOutputPath(root, reference.result_ref, { create: false }));
    const artifact = await readJson(sessionOutputPath(root, reference.artifact_ref, { create: false }));
    const finding = findings.find((item) => item.id === reference.finding_id && hash(JSON.stringify(item)) === reference.finding_sha256);
    if (!finding || artifact.plan_id !== planId || artifact.finding_id !== reference.finding_id || hash(JSON.stringify(artifact.finding)) !== reference.finding_sha256 || result.finding_sha256 !== reference.finding_sha256 || result.artifact_ref !== reference.artifact_ref) throw new Error('Basis recheck result does not match the current original finding');
    await recordBasisRecheck({ root, planId, artifactRef: reference.artifact_ref, result });
    verified.push({ ...result, reviewer_role: finding.reviewer_role, finding_index: finding.finding_index });
  }
  return verified;
}
