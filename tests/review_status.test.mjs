import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateReviewAttempt, inspectReviewHistory } from '../src/workflow/review-attempts.mjs';
import { sessionDirectory, sessionOutputPath } from '../src/workflow/session-output.mjs';

const cli = new URL('../.codex/scripts/harness-review-status.mjs', import.meta.url).pathname;
async function fixture() {
  assert.ok(process.env.HARNESS_SESSION_DIR, 'Run through harness-exec');
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR, 'review-status-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  return root;
}
function run(root, ...args) { return spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, encoding: 'utf8' }); }

test('status observes absent history without creating session files or changing permissions', async () => {
  const root = await fixture();
  try {
    const before = await readdir(join(root, '.git'));
    const path = sessionDirectory(root, { create: false });
    const result = run(root, '--ticket', 'ticket-a', '--plan-set', 'set-a', '--plan', 'plan-a');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).records.length, 4);
    assert.deepEqual(await readdir(join(root, '.git')), before);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    sessionDirectory(root);
    const original = await stat(path);
    await inspectReviewHistory({ root, scope: 'spec-ticket-a-product' });
    assert.equal((await stat(path)).mode, original.mode);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status consolidates exhausted scopes and preserves findings, active waits, corruption and resolutions', async () => {
  const root = await fixture();
  try {
    for (const scope of ['spec-ticket-a-product', 'plan-set-a']) {
      for (let round = 1; round <= 3; round++) {
        const inputs = { source: String(round) };
        const admitted = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
        await updateReviewAttempt({ root, scope, action: 'record', attemptId: admitted.attempt_id, inputs, review: { verdict: 'revise', reviewer_id: `${scope}-${round}`, author_ids: ['writer'], fork_turns: 'none', inputs, findings: [{ severity: 'major', description: `${scope} unresolved`, evidence: 'spec.md:4' }] } });
      }
    }
    await updateReviewAttempt({ root, scope: 'spec-ticket-a-architecture', action: 'begin', inputs: { source: 'architecture' } });
    await updateReviewAttempt({ root, scope: 'implementation-plan-a', action: 'repair', inputs: { fixed_point: 'base', implementation_commit_sha: 'impl', reviewer_ids: ['a', 'b'] }, findings: [{ kind: 'test_defect', summary: 'Missing replay test' }] });
    const path = sessionOutputPath(root, 'runtime/reviews/plan-set-a.json');
    const before = await readFile(path, 'utf8');
    const result = run(root, '--ticket', 'ticket-a', '--plan-set', 'set-a', '--plan', 'plan-a');
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout).records;
    assert.deepEqual(rows.filter((item) => item.next_admission_requires_resolution).map((item) => item.scope), ['spec-ticket-a-product', 'plan-set-a', 'implementation-plan-a']);
    assert.equal(rows[1].recorded_state, 'active');
    assert.equal(rows[1].next_admission_requires_resolution, false);
    assert.equal(rows[0].findings[0].evidence, 'spec.md:4');
    assert.equal(await readFile(path, 'utf8'), before);
    await updateReviewAttempt({ root, scope: 'plan-set-a', action: 'resolve', reason: 'User approved changed scope, request.md:8' });
    assert.equal((await inspectReviewHistory({ root, scope: 'plan-set-a' })).budget.remaining, 3);
    await writeFile(path, '{broken');
    const broken = run(root, '--ticket', 'ticket-a', '--plan-set', 'set-a');
    assert.equal(broken.status, 1);
    assert.equal(JSON.parse(broken.stdout).records.at(-1).recorded_state, 'unreadable');
    assert.equal(JSON.parse(broken.stdout).records[0].findings.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked worktree reads the primary implementation budget and the explicit Spec session', async () => {
  const root = await fixture();
  const linked = root + '-linked';
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  try {
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
    git('worktree', 'add', '-qb', 'linked', linked);
    await updateReviewAttempt({ root, scope: 'implementation-plan-a', action: 'repair', inputs: { fixed_point: 'base', implementation_commit_sha: 'impl' } });
    await updateReviewAttempt({ root, scope: 'spec-ticket-a-product', action: 'begin', inputs: { source: 'one' } });
    const result = run(linked, '--spec-root', root, '--ticket', 'ticket-a', '--plan', 'plan-a');
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout).records;
    assert.equal(rows[0].recorded_state, 'active');
    assert.equal(rows.at(-1).root, root);
    assert.equal(rows.at(-1).budget.used, 1);
  } finally { await rm(linked, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});


test('malformed optional current evidence preserves the other history rows', async () => {
  const root = await fixture();
  try {
    await updateReviewAttempt({ root, scope: 'spec-ticket-a-product', action: 'begin', inputs: { source: 'one' } });
    await writeFile(sessionOutputPath(root, 'runtime/current-review.json'), '{bad');
    const result = run(root, '--ticket', 'ticket-a', '--reviews', 'runtime/current-review.json');
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.records[0].recorded_state, 'active');
    assert.ok(parsed.implementation_findings.error);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('syntactically valid damaged repair budgets and resolution offsets remain unreadable', async () => {
  const root = await fixture();
  try {
    await updateReviewAttempt({ root, scope: 'implementation-plan-a', action: 'repair', inputs: { fixed_point: 'base', implementation_commit_sha: 'impl' } });
    const path = sessionOutputPath(root, 'runtime/reviews/implementation-plan-a.json');
    const history = JSON.parse(await readFile(path, 'utf8'));
    for (const broken of [
      { ...history, repairs: history.repairs.map((item) => ({ ...item, limit: 100 })) },
      { ...history, repair_resolution: { after: 99, reason: 'Offset beyond history' } },
      { ...history, repair_resolution: { after: -1, reason: 'Negative offset' } },
      { ...history, repairs: history.repairs.map((item) => ({ ...item, limit: 2 })), repair_resolution: { after: 1, reason: 'Premature resolution' } },
    ]) {
      await writeFile(path, JSON.stringify(broken));
      const result = run(root, '--ticket', 'ticket-a', '--plan', 'plan-a');
      assert.equal(result.status, 1);
      const rows = JSON.parse(result.stdout).records;
      assert.equal(rows.at(-1).recorded_state, 'unreadable');
      assert.equal(rows[0].recorded_state, 'not-started');
      await assert.rejects(updateReviewAttempt({ root, scope: 'implementation-plan-a', action: 'repair', inputs: { fixed_point: 'base', implementation_commit_sha: 'next' } }), /Invalid/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a valid two-round repair cycle remains readable before and after explicit resolution', async () => {
  const root = await fixture();
  const scope = 'implementation-plan-a';
  try {
    for (let round = 1; round <= 2; round++) {
      await updateReviewAttempt({ root, scope, action: 'repair', maxRounds: 2, inputs: { fixed_point: 'base', implementation_commit_sha: `impl-${round}` } });
      const row = await inspectReviewHistory({ root, scope });
      assert.equal(row.budget.remaining, 2 - round);
      assert.equal(row.next_admission_requires_resolution, round === 2);
    }
    await updateReviewAttempt({ root, scope, action: 'resolve-repair', reason: 'User approved changed recovery scope, request.md:9' });
    assert.equal((await inspectReviewHistory({ root, scope })).budget.used, 0);
    await updateReviewAttempt({ root, scope, action: 'repair', inputs: { fixed_point: 'base', implementation_commit_sha: 'impl-3' } });
    assert.equal((await inspectReviewHistory({ root, scope })).budget.limit, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
