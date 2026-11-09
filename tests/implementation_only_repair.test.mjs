import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReviewAttempt } from '../.harness/src/workflow/review-attempts.mjs';
import { commentTracker } from '../.harness/src/tracker/lifecycle.mjs';

const inputs = (n) => ({ fixed_point: 'f'.repeat(40), implementation_commit_sha: String(n).repeat(40).slice(0, 40), reviewer_ids: [`s${n}`, `p${n}`], plan_set_id: 'set', planning_snapshot_sha256: 'a'.repeat(64) });

test('code-only findings go back to the implementer for up to three rounds without a plan change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'impl-only-'));
  try {
    const scope = { root, scope: 'implementation-P' };
    // The default budget of one round is spent.
    await updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(1), maxRounds: 1, findings: [{ kind: 'implementation_defect' }] });
    await assert.rejects(updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(2), maxRounds: 1, findings: [{ kind: 'implementation_defect' }] }), /budget exhausted/);
    // Implementation-only repairs continue to round three, then ask the user.
    assert.equal((await updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(2), implementationOnly: true, findings: [{ kind: 'implementation_defect' }] })).round, 2);
    assert.equal((await updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(3), implementationOnly: true, findings: [{ kind: 'implementation_defect' }] })).round, 3);
    await assert.rejects(updateReviewAttempt({ ...scope, action: 'repair', inputs: inputs(4), implementationOnly: true, findings: [{ kind: 'implementation_defect' }] }), /budget exhausted/);
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

test('repair points out the implementation-only route when the budget runs out on code-only findings', async () => {
  const source = await readFile(new URL('../.harness/src/wrapper/repair.mjs', import.meta.url), 'utf8');
  assert.match(source, /next_action: 'implementation-only-repair'/);
  assert.match(await readFile(new URL('../.codex/internal-skills/code-review/references/repair.md', import.meta.url), 'utf8'), /next_action: implementation-only-repair/);
});
