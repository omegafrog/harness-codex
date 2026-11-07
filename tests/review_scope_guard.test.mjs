import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planRepairRound, reserveImplementationRepair, runBoundedReviewRepair } from '../.harness/src/wrapper/repair.mjs';
import { sessionDirectory } from '../.harness/src/workflow/session-output.mjs';

const PRODUCT_RULE = '게시글 본문은 최대 5,000자다.';
const basis = { source: 'product_spec', quote: PRODUCT_RULE };
const defect = { id: 'STD-1', kind: 'implementation_defect', severity: 'major', summary: '초과 입력을 저장한다', evidence: 'domain.ts:3', basis };

function evidence({ findings = [], additions = [], commit = 'c1', spec = [], ids = ['std-1', 'spec-1'] } = {}) {
  const reviewInput = {
    repository: '/tmp/consumer', fixed_point: 'base', implementation_commit_sha: commit,
    commit_list: ['base', commit], diff_range: { from: 'base', to: commit }, diff: 'diff --git a b',
    unplanned_additions: additions,
    product_spec_path: 'docs/specs/p/product-spec.md', architecture_spec_path: 'docs/specs/p/architecture-spec.md',
  };
  const review = (role, context_id, list) => ({
    role, context_id, independent: true, fresh_context: true, implementation_commit_sha: commit,
    review_input: reviewInput, state: list.length ? 'failed' : 'passed', report: { findings: list },
  });
  return { reviewInput, reviews: [review('standards', ids[0], findings), review('spec', ids[1], spec)] };
}

test('a repair finding without a Spec basis asks the user instead of repairing', () => {
  const { reviews } = evidence({ findings: [{ id: 'SPEC-4', kind: 'implementation_defect', severity: 'major', summary: 'UI는 raw, 서버는 NFC로 센다', evidence: 'domain.ts:29' }] });
  const decision = planRepairRound({ reviews });
  assert.equal(decision.action, 'block');
  assert.equal(decision.reason, 'unbacked_requirement');
  assert.equal(decision.next_action, 'user-decision');
  assert.deepEqual(decision.user_questions.map((item) => item.finding_id), ['SPEC-4']);
  assert.equal(decision.user_questions[0].question.recommended_option_id, 'reject');
  assert.equal(Object.hasOwn(decision.user_questions[0].question, 'question_id'), false);
});

test('unrequested behavior blocks repair even when the implementer declared it', () => {
  const { reviews } = evidence({ additions: [{ id: 'ADD-NFC', summary: 'NFC 정규화 후 길이 계산', evidence: 'domain.ts:29', benefit: '결합 문자 일관성', cost: '모든 층에 정규화 필요' }] });
  const decision = planRepairRound({ reviews });
  assert.equal(decision.reason, 'unrequested_behavior');
  assert.match(decision.user_questions[0].question.rationale, /결합 문자 일관성/);
  assert.match(decision.user_questions[0].question.rationale, /모든 층에 정규화 필요/);
});

test('a review without the implementer declaration cannot pass', () => {
  const { reviews } = evidence();
  const stripped = reviews.map(({ review_input: { unplanned_additions, ...input }, ...review }) => ({ ...review, review_input: input }));
  const decision = planRepairRound({ reviews: stripped });
  assert.equal(decision.reason, 'unplanned_additions_missing');
});

test('rejecting unrequested behavior removes it past an exhausted budget', () => {
  const { reviews } = evidence({ findings: [{ id: 'UB-1', kind: 'unrequested_behavior', severity: 'major', summary: 'NFC', evidence: 'domain.ts:29' }, defect] });
  const scopeDecisions = [{ finding_id: 'UB-1', choice: 'reject' }];
  const decision = planRepairRound({ reviews, round: 1, maxRounds: 1, scopeDecisions });
  assert.equal(decision.action, 'repair');
  assert.equal(decision.round, 1);
  assert.equal(decision.repair.scope_removal_only, true);
  assert.deepEqual(decision.repair.findings.map((item) => item.id), ['UB-1']);
  assert.equal(decision.repair.findings[0].repair_directive, 'remove_unrequested_behavior');
});

test('keeping unrequested behavior returns to Spec approval', () => {
  const { reviews } = evidence({ findings: [{ id: 'UB-1', kind: 'unrequested_behavior', severity: 'major', summary: 'NFC', evidence: 'domain.ts:29' }] });
  const decision = planRepairRound({ reviews, scopeDecisions: [{ finding_id: 'UB-1', choice: 'adopt' }] });
  assert.equal(decision.reason, 'scope_expansion');
  assert.equal(decision.next_action, 'spec-me');
});

test('a dismissed unbacked finding completes without repair and passes the review gate', async () => {
  const { reviews, reviewInput } = evidence({ findings: [{ id: 'SPEC-4', kind: 'implementation_defect', severity: 'major', summary: 'NFC 필요', evidence: 'domain.ts:29' }] });
  const result = await runBoundedReviewRepair({
    initialImplementation: { commit_sha: 'c1' }, initialReviews: reviews, reviewInput,
    scopeDecisions: [{ finding_id: 'SPEC-4', choice: 'reject' }],
  });
  assert.equal(result.state, 'passed');
  assert.equal(result.reviews.every((review) => review.state === 'passed'), true);
  assert.equal(result.reviews[0].original_state, 'failed');
});

async function consumer() {
  await mkdir('.io/runtime', { recursive: true });
  const root = await mkdtemp(resolve('.io/runtime/scope-guard-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  await mkdir(resolve(root, 'docs/specs/p'), { recursive: true });
  await writeFile(resolve(root, 'docs/specs/p/product-spec.md'), `# Spec\n\n- BR-12: ${PRODUCT_RULE}\n`);
  await writeFile(resolve(root, 'docs/specs/p/architecture-spec.md'), '# Architecture\n');
  return root;
}

test('a quote absent from the approved Spec is treated as an invented requirement', async () => {
  const root = await consumer();
  const { reviews, reviewInput } = evidence({ findings: [{ ...defect, basis: { source: 'product_spec', quote: '입력을 NFC 정규화한 뒤 코드 포인트를 센다' } }] });
  const input = { ...reviewInput, repository: root };
  const local = reviews.map((review) => ({ ...review, review_input: input }));
  const result = await reserveImplementationRepair({ root, planId: 'community', reviewInput: input, reviews: local });
  assert.equal(result.reason, 'unbacked_requirement');
  assert.equal(result.next_action, 'user-decision');
});

test('a verified quote reserves the ordinary repair budget', async () => {
  const root = await consumer();
  const { reviews, reviewInput } = evidence({ findings: [defect] });
  const input = { ...reviewInput, repository: root };
  const local = reviews.map((review) => ({ ...review, review_input: input }));
  const result = await reserveImplementationRepair({ root, planId: 'community', reviewInput: input, reviews: local });
  assert.equal(result.status, 'pass');
  assert.equal(result.round, 1);
});

test('a recorded user answer lets removal pass an exhausted budget, an absent answer does not', async () => {
  const root = await consumer();
  const first = evidence({ findings: [defect] });
  const firstInput = { ...first.reviewInput, repository: root };
  await reserveImplementationRepair({ root, planId: 'community', reviewInput: firstInput, reviews: first.reviews.map((review) => ({ ...review, review_input: firstInput })) });

  const second = evidence({ commit: 'c2', ids: ['std-2', 'spec-2'], findings: [{ id: 'UB-1', kind: 'unrequested_behavior', severity: 'major', summary: 'NFC', evidence: 'domain.ts:29' }] });
  const secondInput = { ...second.reviewInput, repository: root };
  const secondReviews = second.reviews.map((review) => ({ ...review, review_input: secondInput }));
  const answers = resolve(sessionDirectory(root), 'runtime/executions/x');
  await mkdir(answers, { recursive: true });
  await writeFile(resolve(answers, 'answers.json'), JSON.stringify([{ question_id: 'x:1', answer: '제거 (권장)' }]));
  const decision = (choice, question_id = 'x:1') => [{ finding_id: 'UB-1', choice, question_id, answers_ref: 'runtime/executions/x/answers.json' }];

  await assert.rejects(reserveImplementationRepair({ root, planId: 'community', reviewInput: secondInput, reviews: secondReviews, scopeDecisions: decision('reject', 'x:2') }), { code: 'scope_decision_unverified' });
  await assert.rejects(reserveImplementationRepair({ root, planId: 'community', reviewInput: secondInput, reviews: secondReviews, scopeDecisions: decision('adopt') }), { code: 'scope_decision_unverified' });

  const result = await reserveImplementationRepair({ root, planId: 'community', reviewInput: secondInput, reviews: secondReviews, scopeDecisions: decision('reject') });
  assert.equal(result.status, 'pass');
  assert.equal(result.scope_removal, true);
  assert.equal(result.round, 1);
  const history = JSON.parse(await readFile(resolve(sessionDirectory(root), 'runtime/reviews/implementation-community.json'), 'utf8'));
  assert.equal(history.repairs.length, 1);
  assert.equal(history.scope_removals.length, 1);
  await assert.rejects(reserveImplementationRepair({ root, planId: 'community', reviewInput: secondInput, reviews: secondReviews, scopeDecisions: decision('reject') }), /already has a reserved repair/);
});
