import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReviewHistory, updateReviewAttempt } from '../.harness/src/workflow/review-attempts.mjs';
import { commentTracker } from '../.harness/src/tracker/lifecycle.mjs';

const inputs = (n) => ({ fixed_point: 'f'.repeat(40), implementation_commit_sha: String(n).repeat(40).slice(0, 40), reviewer_ids: [`s${n}`, `p${n}`], plan_set_id: 'set', planning_snapshot_sha256: 'a'.repeat(64) });

// The history itself does not limit repair rounds (reserveImplementationRepair asks the user after five automatic ones).
test('repair rounds are recorded without a limit and keep the original fixed point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-unlimited-'));
  try {
    const scope = { root, scope: 'implementation-P' };
    for (let round = 1; round <= 6; round += 1) {
      const reserved = await updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(round), findings: [{ kind: 'in_scope_spec_mismatch' }] });
      assert.equal(reserved.round, round);
      assert.equal(reserved.limit, undefined);
    }
    const history = await inspectReviewHistory(scope);
    assert.equal(history.budget.limit, null);
    assert.equal(history.next_admission_requires_resolution, false);
    // The same commit still cannot reserve twice, and a different fixed point is refused.
    await assert.rejects(updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(6), findings: [] }), /already has a reserved repair/);
    await assert.rejects(updateReviewAttempt({ ...scope, action: 'repair', inputs: { ...inputs(7), fixed_point: 'e'.repeat(40) }, findings: [] }), /original review fixed point/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the implementer records an implementation-only fix on the ticket, not in the plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracker-comment-'));
  try {
    await mkdir(join(root, '.codex'), { recursive: true });
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 1\n    status_field: Workflow Status\n');
    const calls = [];
    await commentTracker({ workspace_root: root, ticket_ref: 'owner/repo#7', body: 'Fixed duplicate sign-up error handling', run: async (command, args) => { calls.push([command, ...args]); return ''; } });
    assert.deepEqual(calls, [['gh', 'issue', 'comment', '7', '--repo', 'owner/repo', '--body', 'Fixed duplicate sign-up error handling']]);
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    await writeFile(join(root, 'docs/plans/set/p.md'), '---\nstatus: in-progress\n---\n# P\n');
    await commentTracker({ workspace_root: root, ticket_ref: 'docs/plans/set/p.md', body: 'Fixed it' });
    assert.match(await readFile(join(root, 'docs/plans/set/p.md'), 'utf8'), /## 수정 기록\n\n- \d{4}-\d{2}-\d{2}: Fixed it\n$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviews already handed to the Spec owner ask for a fresh review instead of spec-me again', async () => {
  const { reserveImplementationRepair } = await import('../.harness/src/wrapper/repair.mjs');
  const reviews = [{ role: 'standards', context_id: 's1' }, { role: 'spec', context_id: 'p1' }];
  const result = await reserveImplementationRepair({ root: tmpdir(), planId: 'auth', reviewInput: {}, reviews, specHandoff: { at: '2026-11-10T00:00:00Z', reviewer_ids: ['s1', 'p1'] } });
  assert.equal(result.next_action, 'fresh-review');
  // New reviewers are judged normally.
  await assert.rejects(reserveImplementationRepair({ root: tmpdir(), planId: 'auth', reviewInput: {}, reviews: [{ role: 'standards', context_id: 's2' }, { role: 'spec', context_id: 'p2' }], specHandoff: { reviewer_ids: ['s1', 'p1'] } }), /Review input must belong/);
});
