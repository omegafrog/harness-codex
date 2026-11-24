import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateImplementationReview, findingKey, markRecurrence } from '../.harness/src/wrapper/review-recurrence.mjs';
import { updateReviewAttempt } from '../.harness/src/workflow/review-attempts.mjs';
import { consumerWorkflow } from './support/consumer-workflow.mjs';

const finding = (id, fields) => ({ id, kind: 'implementation_defect', severity: 'major', summary: 'x', evidence: '', ...fields });
const review = (role, context, findings, extra = {}) => ({ role, context_id: context, state: findings.length ? 'failed' : 'passed', report: { findings }, ...extra });
const evidence = (commit, reviews) => ({ review_input: { fixed_point: 'fp', implementation_commit_sha: commit }, reviews });

test('a finding recurs when the same rule, file and anchor come back, whatever line or wording moved', () => {
  const previous = [
    finding('A1', { summary: 'Message send skips the length check', evidence: 'src/chat/send.mjs:40 violates BR-02' }),
    finding('A2', { summary: 'Retry duplicates the stored message', evidence: 'src/chat/retry.mjs:12' }),
    finding('A3', { summary: 'Unused import in the repository', evidence: 'src/chat/repo.mjs:3' }),
  ];
  const current = [
    finding('B1', { summary: 'Sending still skips the length validation', evidence: 'src/chat/send.mjs:57 violates BR-02' }),
    finding('B2', { summary: 'Retry duplicates the stored message', evidence: 'src/chat/retry.mjs:99' }),
    finding('B3', { summary: 'Unused import in the repository', evidence: 'src/chat/other-repo.mjs:3' }),
    finding('B4', { summary: 'Message send skips the length check', evidence: 'src/chat/send.mjs:40 violates BR-05' }),
  ];
  const result = markRecurrence(previous, current);
  assert.deepEqual(result.marks.map((mark) => [mark.id, mark.recurrence, mark.matches ?? null]), [['B1', 'recurring', 'A1'], ['B2', 'recurring', 'A2'], ['B3', 'new', null], ['B4', 'new', null]]);
  assert.equal(result.recurring, 2);
  assert.equal(result.new, 2);
  assert.deepEqual(markRecurrence([], current).marks.map((mark) => mark.recurrence), ['new', 'new', 'new', 'new']);
  assert.deepEqual(findingKey({ rule: 'S1-BR-02', file: 'a/src/x.mjs:9', anchor: 'send' }), { rule: 'S1-BR-02', file: 'src/x.mjs', anchor: 'send', specific_rule: true });
});

test('a re-assembled implementation review marks each finding against the previous round and counts them', () => {
  const standards1 = review('standards', 'standards-1', [finding('S1', { summary: 'Missing guard', evidence: 'src/a.mjs:1' }), finding('S2', { summary: 'Naming', evidence: 'src/b.mjs:1' })]);
  const spec1 = review('spec', 'spec-1', [finding('P1', { summary: 'Rule BR-01 is not implemented', evidence: 'src/c.mjs:5 BR-01' })]);
  const first = annotateImplementationReview(null, evidence('c1', [standards1, spec1]));
  assert.deepEqual(first.recurrence, { compared: false, reason: 'first_review_round', recurring: 0, new: 3 });

  const standards2 = review('standards', 'standards-2', [finding('S3', { summary: 'Missing guard', evidence: 'src/a.mjs:8' }), finding('S4', { summary: 'A different problem', evidence: 'src/d.mjs:2' })]);
  const spec2 = review('spec', 'spec-2', [finding('P2', { summary: 'BR-01 still not implemented', evidence: 'src/c.mjs:6 BR-01' })]);
  const second = annotateImplementationReview(first, evidence('c2', [standards2, spec2]));
  assert.deepEqual(second.recurrence, { compared: true, previous_commit: 'c1', previous_reviewers: ['standards-1', 'spec-1'], recurring: 2, new: 1 });
  assert.deepEqual(second.reviews[0].report.findings.map(({ id, recurrence, recurs_from }) => [id, recurrence, recurs_from ?? null]), [['S3', 'recurring', 'S1'], ['S4', 'new', null]]);
  assert.deepEqual(second.reviews[0].recurrence, { recurring: 1, new: 1 });
  assert.equal(second.reviews[1].report.findings[0].recurs_from, 'P1');
  assert.equal(JSON.stringify(first).includes('"recurrence":"'), false, 'the first round marks no finding');

  // Assembling the same reviewers' round again keeps the comparison that round already made instead of comparing it with itself.
  const again = annotateImplementationReview(second, evidence('c2', [standards2, spec2]));
  assert.deepEqual(again.recurrence, second.recurrence);
  assert.deepEqual(again.reviews.map((item) => item.report.findings.map((entry) => entry.recurrence)), [['recurring', 'new'], ['recurring']]);
  assert.deepEqual(annotateImplementationReview(first, evidence('c1', [standards1, spec1])).recurrence, first.recurrence, 'the earlier comparison is kept');
  assert.equal(annotateImplementationReview({ review_input: first.review_input, reviews: first.reviews }, evidence('c1', [standards1, spec1])).recurrence.reason, 'same_review_round', 'evidence from before recurrence marking is not compared with itself');

  // A carried-forward clean pass has no findings to mark and keeps its entry unchanged.
  const carried = review('standards', 'standards-2', [], { carried_forward: { from_commit: 'c1' } });
  const third = annotateImplementationReview(second, evidence('c3', [carried, review('spec', 'spec-3', [finding('P3', { summary: 'BR-01 still not implemented', evidence: 'src/c.mjs:7 BR-01' })])]));
  assert.deepEqual(third.reviews[0], carried);
  assert.deepEqual(third.recurrence, { compared: true, previous_commit: 'c2', previous_reviewers: ['standards-2', 'spec-2'], recurring: 1, new: 0 });
});

test('a recorded re-review of a plan, Spec or contract scope states how many findings recur', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-recurrence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = 'plan-example';
  const inputs = { 'docs/plans/example/one.md': 'v1' };
  const record = async (reviewer, findings, verdict = 'revise') => {
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    return updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review: { verdict, reviewer_id: reviewer, author_ids: ['author'], fork_turns: 'none', findings } });
  };
  const first = await record('reviewer-a', [
    { severity: 'blocker', description: 'BR-01 has no acceptance criterion', evidence: 'docs/plans/example/one.md:10' },
    { severity: 'major', description: 'Ticket order is ambiguous', evidence: 'docs/plans/example/plans.md:3' },
  ]);
  assert.equal(first.recurrence, undefined, 'the first review has nothing to compare with');
  const second = await record('reviewer-b', [
    { severity: 'blocker', description: 'BR-01 acceptance criterion is still missing', evidence: 'docs/plans/example/one.md:14' },
    { severity: 'major', description: 'Estimate is missing', evidence: 'docs/plans/example/one.md:20' },
  ]);
  assert.deepEqual(second.recurrence, { recurring: 1, new: 1 });
  const history = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-example.json'), 'utf8'));
  assert.deepEqual(history.attempts.at(-1).recurrence.findings, [{ index: 0, recurrence: 'recurring' }, { index: 1, recurrence: 'new' }]);
  const third = await record('reviewer-c', [], 'pass');
  assert.deepEqual(third.recurrence, { recurring: 0, new: 0 });
  assert.equal(third.status, 'pass');
});

test('the installed workflow context reports the recurring and new counts of a plan review', async (t) => {
  const { workspace, planSetId, invoke } = await consumerWorkflow(t, '메시지 전송 기능');
  await mkdir(join(workspace, 'docs/plans', planSetId), { recursive: true });
  await writeFile(join(workspace, 'docs/plans', planSetId, 'chat-send.md'), '# 메시지 전송\n');
  const saved = evidence('c2', [
    review('standards', 'standards-2', [{ ...finding('S3', {}), recurrence: 'recurring', recurs_from: 'S1' }, { ...finding('S4', {}), recurrence: 'new' }], { recurrence: { recurring: 1, new: 1 } }),
    review('spec', 'spec-2', []),
  ]);
  saved.recurrence = { compared: true, previous_commit: 'c1', recurring: 1, new: 1 };
  await mkdir(join(workspace, '.io/runtime/reviews'), { recursive: true });
  await writeFile(join(workspace, '.io/runtime/reviews/implementation-chat-send-evidence.json'), JSON.stringify(saved));
  const context = invoke(workspace, 'harness-context.mjs', ['--verbose']);
  assert.deepEqual(context.implementation_reviews['chat-send'].reviews, [{ role: 'standards', state: 'failed', findings: 2, recurring: 1 }, { role: 'spec', state: 'passed', findings: 0 }]);
  assert.equal(context.implementation_reviews['chat-send'].recurring_findings, 1);
  assert.equal(context.implementation_reviews['chat-send'].new_findings, 1);
  const compact = invoke(workspace, 'harness-context.mjs', []);
  assert.equal(compact.implementation_reviews['chat-send'].recurring_findings, 1, 'the compact context keeps the counts');
});
