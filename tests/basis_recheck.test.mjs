import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareBasisRecheck, recordBasisRecheck, verifiedBasisRecheckResults } from '../.harness/src/wrapper/basis-recheck.mjs';
import { normalizeReviewContent } from '../.harness/src/workflow/review-delta.mjs';
import { inspectPlanSet, updatePlanReview } from '../.harness/src/workflow/plan-review.mjs';
import { inspectReviewHistory } from '../.harness/src/workflow/review-attempts.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(resolve('.io/runtime/basis-recheck-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(root, 'README.md'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const files = {
    'docs/specs/demo/product-spec.md': '# Product\n\n- BR-1: Save valid posts.\n',
    'docs/specs/demo/architecture-spec.md': '# Architecture\n\n- UC-1: Store a post.\n',
    'docs/plans/demo/plans.md': '# Plans\n',
    'docs/plans/demo/create.md': '---\nstatus: ready\n---\n# Create\n\nStore posts.\n',
    'docs/plans/demo/follow-up.md': '# Follow up\n\nMissing prerequisite work.\n',
    'src/post.js': 'const value = "old";\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const inputHashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hash(path === 'docs/plans/demo/create.md' ? normalizeReviewContent(path, Buffer.from(content)) : content)]));
  const admissionRef = 'runtime/executions/review-a/plan-review-admission-attempt-a.json';
  const admissionPath = join(root, '.io', admissionRef);
  await mkdir(join(admissionPath, '..'), { recursive: true });
  await writeFile(admissionPath, JSON.stringify({ inputs: inputHashes, files: Object.entries(files).map(([path, content]) => ({ path, content, sha256: inputHashes[path], normalization: path === 'docs/plans/demo/create.md' ? 'frontmatter-status-excluded-v1' : 'raw-v1' })) }));
  const historyPath = join(root, '.io/runtime/reviews/plan-demo.json');
  await mkdir(join(historyPath, '..'), { recursive: true });
  await writeFile(historyPath, JSON.stringify({ attempts: [{ status: 'pass', review: { verdict: 'pass' }, inputs: inputHashes, admission_ref: admissionRef }] }));
  git('add', '.'); git('commit', '-qm', 'snapshot');
  await writeFile(join(root, 'src/post.js'), 'const value = "new";\n');
  git('add', 'src/post.js'); git('commit', '-qm', 'implementation');
  const evidencePath = join(root, '.io/runtime/reviews/implementation-create-evidence.json');
  await mkdir(join(evidencePath, '..'), { recursive: true });
  await writeFile(evidencePath, JSON.stringify({ reviews: [{ role: 'standards', report: { findings: [{ id: 'F-1' }] } }] }));
  return { root, inputHashes, files, head: git('rev-parse', 'HEAD').trim(), fixedPoint: git('rev-parse', 'HEAD^').trim() };
}

test('basis recheck captures hash-validated historical and current review snapshots, then validates child result', async () => {
  const { root, files, head, fixedPoint } = await fixture();
  const inputHashes = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hash(path === 'docs/plans/demo/create.md' ? normalizeReviewContent(path, Buffer.from(content)) : content)]));
  const reviewInput = {
    plan_set_id: 'demo', planning_snapshot_sha256: hash(JSON.stringify(Object.keys(inputHashes).sort().map((key) => [key, inputHashes[key]]))),
    product_spec_path: 'docs/specs/demo/product-spec.md', architecture_spec_path: 'docs/specs/demo/architecture-spec.md', diff: 'diff --git a/src/post.js b/src/post.js', implementation_commit_sha: head, fixed_point: fixedPoint,
    canonical_plan: { reference: 'docs/plans/demo/create.md', sha256: hash(normalizeReviewContent('docs/plans/demo/create.md', Buffer.from(files['docs/plans/demo/create.md']))) },
  };
  const finding = { id: 'F-1', kind: 'implementation_defect', reviewer_role: 'standards', finding_index: 0, basis: { source: 'product_spec', quote: 'a quote that failed verification' } };
  const ref = await prepareBasisRecheck({ root, planId: 'create', reviewInput, finding });
  const artifact = JSON.parse(await readFile(join(root, '.io', ref), 'utf8'));
  assert.equal(artifact.review_time.files['docs/specs/demo/product-spec.md'].content, files['docs/specs/demo/product-spec.md']);
  assert.equal(artifact.current.files['docs/plans/demo/create.md'].sha256, hash(normalizeReviewContent('docs/plans/demo/create.md', Buffer.from(files['docs/plans/demo/create.md']))));
  const result = { schema_version: 1, finding_id: 'F-1', source_plan_id: 'create', classification: 'unsupported_finding', route: 'dismiss', affected_plan_id: 'create', summary: 'Historical and current rules do not support this repair.', evidence: [
    { snapshot: 'review_time', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'The admitted Product Spec states the actual requirement.' },
    { snapshot: 'current', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'The current Product Spec retains the same requirement.' },
  ] };
  const recorded = await recordBasisRecheck({ root, planId: 'create', artifactRef: ref, result });
  assert.equal(recorded.route, 'dismiss');
  const verified = await verifiedBasisRecheckResults({ root, planId: 'create', findings: [artifact.finding], results: [{ finding_id: 'F-1', finding_sha256: recorded.finding_sha256, artifact_ref: ref, result_ref: recorded.evidence_ref }] });
  assert.equal(verified[0].route, 'dismiss');
  const supported = { ...result, classification: 'supported_finding', route: 'implementation', summary: 'The current implementation violates the cited requirement.', evidence: [
    { snapshot: 'current', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'This is the current required behavior.' },
    { snapshot: 'current', path: 'implementation.diff', quote: 'const value = "new";', analysis: 'The implementation diff shows the changed behavior under review.' },
  ] };
  await writeFile(join(root, 'src/new-untracked.js'), 'const extra = true;\n');
  await assert.rejects(recordBasisRecheck({ root, planId: 'create', artifactRef: ref, result: supported }), /Untracked implementation files changed/);
  await unlink(join(root, 'src/new-untracked.js'));
  assert.equal((await recordBasisRecheck({ root, planId: 'create', artifactRef: ref, result: supported })).route, 'implementation');
  const planGap = { ...result, classification: 'plan_gap', route: 'to-ticket', source_plan_id: 'create', affected_plan_id: 'follow-up', summary: 'A sibling plan owns a prerequisite.', evidence: [
    { snapshot: 'current', path: 'docs/plans/demo/follow-up.md', quote: 'Missing prerequisite work.', analysis: 'The sibling canonical plan lacks the prerequisite coverage.' },
  ] };
  assert.equal((await recordBasisRecheck({ root, planId: 'create', artifactRef: ref, result: planGap })).affected_plan_id, 'follow-up');
  await writeFile(join(root, 'docs/plans/demo/create.md'), '# changed\n');
  await assert.rejects(recordBasisRecheck({ root, planId: 'create', artifactRef: ref, result }), /changed during basis recheck/);
});

test('basis recheck refuses missing historical admissions and unsupported child classifications', async () => {
  const { root } = await fixture();
  await assert.rejects(prepareBasisRecheck({ root, planId: 'create', reviewInput: { plan_set_id: 'demo', planning_snapshot_sha256: 'b'.repeat(64) }, finding: { id: 'F-2', basis: {} } }), /Historical plan review snapshot is unavailable/);
  const artifactRef = 'runtime/reviews/fake-basis.json';
  const artifactPath = join(root, '.io', artifactRef);
  await mkdir(join(artifactPath, '..'), { recursive: true });
  await writeFile(artifactPath, JSON.stringify({ schema_version: 1, finding_id: 'F-2', plan_id: 'create', review_time: { plan_set_id: 'demo' }, current: { head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: {} } }));
  await assert.rejects(recordBasisRecheck({ root, planId: 'create', artifactRef, result: { schema_version: 1, finding_id: 'F-2', source_plan_id: 'create', classification: 'unsupported_finding', route: 'spec-me', affected_plan_id: 'create', summary: 'x', evidence: [] } }), /Invalid basis-recheck result/);
});

async function cliWorkspace() {
  const root = await mkdtemp(resolve('.io/runtime/basis-recheck-cli-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const put = async (path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };
  git('init', '-q');
  await put('README.md', 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  for (const [path, content] of Object.entries({
    'docs/specs/demo/product-spec.md': '# Product\n\n- BR-1: Save valid posts.\n',
    'docs/specs/demo/architecture-spec.md': '# Architecture\n\n- UC-1: Store a post.\n',
    'docs/plans/demo/plans.md': '# Plans\n',
    'docs/plans/demo/create.md': '# Create\n\nSave valid posts.\n',
    'docs/plans/demo/follow-up.md': '# Follow up\n\nMissing prerequisite work.\n',
    'src/post.js': 'const value = "old";\n',
  })) await put(path, content);
  git('add', '.'); git('commit', '-qm', 'planning snapshot');
  const fixed = git('rev-parse', 'HEAD').trim();
  const oldExecution = process.env.HARNESS_SKILL_EXECUTION_ID, oldRoot = process.env.HARNESS_WORKSPACE_ROOT;
  try {
    process.env.HARNESS_SKILL_EXECUTION_ID = 'basis-review'; process.env.HARNESS_WORKSPACE_ROOT = root;
    const began = await updatePlanReview({ root, planSetId: 'demo', action: 'begin' });
    delete process.env.HARNESS_SKILL_EXECUTION_ID; delete process.env.HARNESS_WORKSPACE_ROOT;
    await updatePlanReview({ root, planSetId: 'demo', action: 'record', attemptId: began.attempt_id, review: { verdict: 'pass', findings: [], reviewer_id: 'plan-reviewer', author_ids: ['orchestrator'], fork_turns: 'none' } });
  } finally {
    if (oldExecution === undefined) delete process.env.HARNESS_SKILL_EXECUTION_ID; else process.env.HARNESS_SKILL_EXECUTION_ID = oldExecution;
    if (oldRoot === undefined) delete process.env.HARNESS_WORKSPACE_ROOT; else process.env.HARNESS_WORKSPACE_ROOT = oldRoot;
  }
  await put('src/post.js', 'const value = "new";\n'); git('add', 'src/post.js'); git('commit', '-qm', 'implementation');
  const implementation = git('rev-parse', 'HEAD').trim();
  const planCheck = await inspectPlanSet({ root, planSetId: 'demo', planId: 'create', phase: 'dispatch' });
  const reviewInput = {
    repository: root, fixed_point: fixed, implementation_commit_sha: implementation, commit_list: [fixed, implementation],
    diff_range: { from: fixed, to: implementation }, diff: git('diff', `${fixed}..${implementation}`), unplanned_additions: [],
    product_spec_path: planCheck.details.product_spec_path, architecture_spec_path: planCheck.details.architecture_spec_path,
    plan_set_id: 'demo', planning_snapshot_sha256: planCheck.details.review_snapshot_sha256, canonical_plan: planCheck.details.canonical_plan,
  };
  const finding = { id: 'F-1', kind: 'implementation_defect', severity: 'major', summary: 'Observed behavior differs', evidence: 'src/post.js:1', basis: { source: 'product_spec', quote: 'This unsupported quote does not exist.' }, intent_ref: 'BR-1', failure_scenario: 'A valid post is not saved.' };
  const reviews = ['standards', 'spec'].map((role, index) => ({ role, context_id: `review-${role}`, independent: true, fresh_context: true, implementation_commit_sha: implementation, review_input: reviewInput, state: index === 0 ? 'failed' : 'passed', report: { findings: index === 0 ? [finding] : [] } }));
  const evidencePath = join(root, '.io/runtime/reviews/implementation-create-evidence.json');
  await mkdir(join(evidencePath, '..'), { recursive: true });
  await writeFile(evidencePath, JSON.stringify({ review_input: reviewInput, reviews }));
  return { root, reviewInput, finding, git };
}

function reviewCli(root, ...args) {
  const result = spawnSync(process.execPath, [resolve('.codex/scripts/harness-code-review.mjs'), ...args, '--root', root, '--plan', 'create', '--reviews', 'runtime/reviews/implementation-create-evidence.json'], { encoding: 'utf8' });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test('repair CLI blocks without a child result, accepts validated dismissal, and routes implementation and sibling plan work', async () => {
  const dismissed = await cliWorkspace();
  const initial = reviewCli(dismissed.root, 'repair');
  assert.equal(initial.json.next_action, 'review-coordination');
  assert.equal(initial.json.basis_rechecks.length, 1);
  assert.equal((await inspectReviewHistory({ root: dismissed.root, scope: 'implementation-create' })).budget.used, 0);
  const artifactRef = initial.json.basis_rechecks[0].artifact_ref;
  assert.equal(reviewCli(dismissed.root, 'record-basis-result', '--artifact', artifactRef, '--result', 'runtime/reviews/missing-child.json').status, 1);
  assert.equal(reviewCli(dismissed.root, 'repair').json.next_action, 'review-coordination');
  const artifact = JSON.parse(await readFile(join(dismissed.root, '.io', artifactRef), 'utf8'));
  const childResult = {
    schema_version: 1, finding_id: 'F-1', source_plan_id: 'create', classification: 'unsupported_finding', affected_plan_id: 'create', route: 'dismiss', summary: 'The review request is not supported by either snapshot.', evidence: [
      { snapshot: 'review_time', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'The admitted requirement is narrower than the claim.' },
      { snapshot: 'current', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'The current requirement remains unchanged.' },
    ],
  };
  const childPath = join(dismissed.root, '.io/runtime/reviews/child-dismiss.json'); await writeFile(childPath, JSON.stringify(childResult));
  assert.equal(reviewCli(dismissed.root, 'record-basis-result', '--artifact', artifactRef, '--result', 'runtime/reviews/child-dismiss.json').status, 0);
  assert.equal(reviewCli(dismissed.root, 'repair').json.state, 'passed');
  assert.equal((await inspectReviewHistory({ root: dismissed.root, scope: 'implementation-create' })).budget.used, 0);

  const implemented = await cliWorkspace();
  const pending = reviewCli(implemented.root, 'repair').json;
  const supported = { ...childResult, classification: 'supported_finding', route: 'implementation', summary: 'The implementation change conflicts with the current requirement.', evidence: [
    { snapshot: 'current', path: 'docs/specs/demo/product-spec.md', quote: 'BR-1: Save valid posts.', analysis: 'The requirement defines the expected operation.' },
    { snapshot: 'current', path: 'implementation.diff', quote: 'const value = "new";', analysis: 'The committed implementation diff contains the changed value.' },
  ] };
  await writeFile(join(implemented.root, '.io/runtime/reviews/child-supported.json'), JSON.stringify(supported));
  assert.equal(reviewCli(implemented.root, 'record-basis-result', '--artifact', pending.basis_rechecks[0].artifact_ref, '--result', 'runtime/reviews/child-supported.json').status, 0);
  assert.equal(reviewCli(implemented.root, 'repair').json.round, 1);
  assert.equal((await inspectReviewHistory({ root: implemented.root, scope: 'implementation-create' })).budget.used, 1);

  const planGap = await cliWorkspace();
  const gapPending = reviewCli(planGap.root, 'repair').json;
  const gapResult = { ...childResult, classification: 'plan_gap', route: 'to-ticket', affected_plan_id: 'follow-up', summary: 'The sibling plan owns a missing prerequisite.', evidence: [
    { snapshot: 'current', path: 'docs/plans/demo/follow-up.md', quote: 'Missing prerequisite work.', analysis: 'The existing sibling plan is missing the required prerequisite.' },
  ] };
  await writeFile(join(planGap.root, '.io/runtime/reviews/child-plan-gap.json'), JSON.stringify(gapResult));
  const gapArtifact = gapPending.basis_rechecks[0].artifact_ref;
  assert.equal(reviewCli(planGap.root, 'record-basis-result', '--artifact', gapArtifact, '--result', 'runtime/reviews/child-plan-gap.json').status, 0);
  const routed = reviewCli(planGap.root, 'repair');
  assert.equal(routed.json.next_action, 'to-ticket');
  assert.equal(routed.json.basis_recheck.affected_plan_id, 'follow-up');
  assert.equal((await inspectReviewHistory({ root: planGap.root, scope: 'implementation-create' })).budget.used, 0);
});
