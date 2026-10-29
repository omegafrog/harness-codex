import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPlanSet, snapshotPlanSet, updatePlanReview, validatePlanReviewAdmission } from '../src/workflow/plan-review.mjs';
import { sessionDirectory, sessionOutputPath } from '../src/workflow/session-output.mjs';
import { reviewDelta } from '../src/workflow/review-delta.mjs';
import { createHash } from 'node:crypto';

test('review delta falls back safely for missing baseline and duplicate headings', async () => {
  const root = await mkdtemp(join(sessionDirectory(process.cwd()), 'review-delta-'));
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const first = '# Spec\n## Repeated\nA\n## Repeated\nB\n';
    const next = '# Spec\n## Repeated\nA\n## Repeated\nC\n';
    await writeFile(join(root, 'spec.md'), first);
    const initial = await reviewDelta({ root, inputs: { 'spec.md': hash(first) }, previousInputs: null });
    assert.equal(initial.mode, 'full');
    await writeFile(join(root, 'spec.md'), next);
    const ambiguous = await reviewDelta({ root, inputs: { 'spec.md': hash(next) }, previousInputs: { 'spec.md': hash(first) } });
    assert.equal(ambiguous.changed[0].scope, 'full_file');
    const missing = await reviewDelta({ root, inputs: { 'spec.md': hash(next) }, previousInputs: { 'spec.md': 'a'.repeat(64) } });
    assert.equal(missing.changed[0].scope, 'full_file');
    await assert.rejects(reviewDelta({ root, inputs: { 'spec.md': hash(first) }, previousInputs: null }), /changed during admission/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan review CLI records an admitted review through the shared plan-review function', async () => {
  const temporary = sessionOutputPath(process.cwd(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'plan-review-cli-'));
  const cli = new URL('../.codex/scripts/harness-plan-review.mjs', import.meta.url);
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(join(root, 'docs/specs/42'), { recursive: true });
    await mkdir(join(root, 'docs/plans/42'), { recursive: true });
    await writeFile(join(root, 'docs/specs/42/product-spec.md'), '# Product\n');
    await writeFile(join(root, 'docs/specs/42/architecture-spec.md'), '# Architecture\n');
    await writeFile(join(root, 'docs/plans/42/plans.md'), '# Plans\n- Product Spec: `docs/specs/42/product-spec.md`\n- Architecture Spec: `docs/specs/42/architecture-spec.md`\n');
    await writeFile(join(root, 'docs/plans/42/plan-a.md'), '# Plan A\n');

    const begin = spawnSync(process.execPath, [cli.pathname, 'begin', '--root', root, '--plan-set', '42'], { cwd: root, encoding: 'utf8' });
    assert.equal(begin.status, 0, begin.stderr);
    const admission = JSON.parse(begin.stdout);
    await validatePlanReviewAdmission({ root, planSetId: '42', admission });
    await assert.rejects(validatePlanReviewAdmission({ root, planSetId: '42', admission: { ...admission, review_delta: { mode: 'incremental', changed: [] } } }), /delta does not match/);
    await assert.rejects(validatePlanReviewAdmission({ root, planSetId: 'wrong', admission }), /No such file|ENOENT/);
    const reviewPath = sessionOutputPath(root, 'runtime/reviews/plan-42-review.json');
    await mkdir(join(reviewPath, '..'), { recursive: true });
    await writeFile(reviewPath, JSON.stringify({
      plan_set_id: '42', reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none',
      verdict: 'pass', findings: [{ severity: 'minor', description: 'Minor note', evidence: ['plan-a.md §1', 'product-spec.md §2'] }], inputs: admission.inputs,
    }));
    const record = spawnSync(process.execPath, [cli.pathname, 'record', '--root', root, '--plan-set', '42', '--attempt', admission.attempt_id, '--reviews', 'runtime/reviews/plan-42-review.json'], { cwd: root, encoding: 'utf8' });
    assert.equal(record.status, 0, record.stderr);
    assert.equal(JSON.parse(record.stdout).status, 'pass');
    const history = JSON.parse(await readFile(sessionOutputPath(root, 'runtime/reviews/plan-42.json'), 'utf8'));
    assert.equal(history.attempts[0].review.findings[0].evidence, 'plan-a.md §1; product-spec.md §2');
    await writeFile(join(root, 'docs/specs/42/product-spec.md'), '# Product changed\n');
    await assert.rejects(validatePlanReviewAdmission({ root, planSetId: '42', admission, requireActive: false }), /snapshot is stale/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked-worktree plan review history is read from return_root', async () => {
  const temporary = sessionOutputPath(process.cwd(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'plan-review-main-'));
  const linked = `${root}-linked`;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Harness Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'harness-test@example.invalid'], { cwd: root });
    await mkdir(join(root, 'docs/specs/42'), { recursive: true });
    await mkdir(join(root, 'docs/plans/42'), { recursive: true });
    await writeFile(join(root, 'docs/specs/42/product-spec.md'), '# Product\n');
    await writeFile(join(root, 'docs/specs/42/architecture-spec.md'), '# Architecture\n');
    await writeFile(join(root, 'docs/plans/42/plans.md'), '# Plans\n- Product Spec: `docs/specs/42/product-spec.md`\n- Architecture Spec: `docs/specs/42/architecture-spec.md`\n');
    await writeFile(join(root, 'docs/plans/42/plan-a.md'), '# Plan A\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root });

    const sharedSession = sessionDirectory(linked);
    await writeFile(join(sharedSession, 'worktree.json'), JSON.stringify({
      schema_version: 1, worktree_id: 'b89123a7-90d9-4ded-8912-2c5f7fa5e243', workspace: linked,
      common: join(root, '.git'), return_root: root, branch: 'detached', state: 'active',
      session_directory: sharedSession, plan_set_id: '42',
    }));
    const admission = await updatePlanReview({ root: linked, planSetId: '42', action: 'begin' });
    const review = { plan_set_id: '42', reviewer_id: 'fresh-reviewer', author_ids: ['plan-author'], fork_turns: 'none', verdict: 'pass', findings: [], inputs: admission.inputs };
    await updatePlanReview({ root: linked, planSetId: '42', action: 'record', attemptId: admission.attempt_id, review });
    assert.equal((await inspectPlanSet({ root: linked, planSetId: '42', phase: 'planning' })).status, 'pass');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: root }); } catch {}
    await rm(linked, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('plan review compares and snapshots the Specs and complete canonical plan set without a ledger', async () => {
  const temporary = sessionOutputPath(process.cwd(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'plan-review-'));
  try {
    await mkdir(join(root, 'docs/specs/42'), { recursive: true });
    await mkdir(join(root, 'docs/plans/42'), { recursive: true });
    await writeFile(join(root, 'docs/specs/42/product-spec.md'), '# Product\n');
    await writeFile(join(root, 'docs/specs/42/architecture-spec.md'), '# Architecture\n');
    await writeFile(join(root, 'docs/plans/42/plans.md'), '# Plans\n- Product Spec: `docs/specs/42/product-spec.md`\n- Architecture Spec: `docs/specs/42/architecture-spec.md`\n');
    await writeFile(join(root, 'docs/plans/42/plan-a.md'), '# Plan A\nBusiness-rule unit test: tests/rule.test.mjs\n');
    const before = await snapshotPlanSet({ root, planSetId: '42' });
    assert.deepEqual(before.plans.map(({ id }) => id), ['plan-a']);
    assert.equal(await inspectPlanSet({ root, planSetId: '42', phase: 'planning' }).then((result) => result.status), 'blocked');

    const admission = await updatePlanReview({ root, planSetId: '42', action: 'begin' });
    const review = {
      plan_set_id: '42', reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none',
      verdict: 'pass', findings: [], inputs: admission.inputs,
    };
    await updatePlanReview({ root, planSetId: '42', action: 'record', attemptId: admission.attempt_id, review });
    assert.equal((await inspectPlanSet({ root, planSetId: '42', phase: 'planning' })).status, 'pass');
    await writeFile(join(root, 'docs/specs/42/product-spec.md'), '# Product changed\n');
    assert.match((await inspectPlanSet({ root, planSetId: '42', phase: 'planning' })).reason, /stale/);
    assert.equal(before.inputs['docs/plans/42/plan-a.md'] !== (await snapshotPlanSet({ root, planSetId: '42' })).inputs['docs/plans/42/plan-a.md'], false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
