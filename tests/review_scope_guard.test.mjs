import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planRepairRound, reserveImplementationRepair, runBoundedReviewRepair } from '../.harness/src/wrapper/repair.mjs';
import { sessionDirectory } from '../.harness/src/workflow/session-output.mjs';
import { decisionsWithoutDelegation, rulesMissingIntent } from '../.harness/src/workflow/spec-review.mjs';

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

test('an advisory without an explicit blocking flag does not block', () => {
  const { reviews } = evidence({ findings: [{ id: 'A-1', kind: 'advisory', severity: 'minor', summary: '이름 개선', evidence: 'a.ts:1' }] });
  const decision = planRepairRound({ reviews });
  assert.equal(decision.action, 'complete');
  assert.deepEqual(decision.classification.advisory.map((item) => item.id), ['A-1']);
  const forced = evidence({ findings: [{ id: 'A-2', kind: 'advisory', severity: 'minor', blocking: true, summary: 'x', evidence: 'a.ts:1' }] });
  assert.equal(planRepairRound({ reviews: forced.reviews }).action, 'block');
});

test('scope groups ask once for findings that share one item', () => {
  const link = { summary: '홈 링크', evidence: 'page.tsx:1', rule_impact: 'none' };
  const { reviews } = evidence({
    additions: [{ id: 'ADD-1', ...link }],
    findings: [{ id: 'STD-U1', kind: 'unrequested_behavior', severity: 'major', ...link }],
    spec: [{ id: 'SPEC-U1', kind: 'unrequested_behavior', severity: 'major', ...link }],
  });
  const scopeGroups = [{ id: 'home-link', finding_ids: ['ADD-1', 'STD-U1', 'SPEC-U1'] }];
  const blocked = planRepairRound({ reviews, scopeGroups });
  assert.equal(blocked.user_questions.length, 1);
  assert.equal(blocked.user_questions[0].finding_id, 'home-link');
  assert.deepEqual(blocked.user_questions[0].finding_ids, ['ADD-1', 'STD-U1', 'SPEC-U1']);
  const decided = planRepairRound({ reviews, scopeGroups, scopeDecisions: [{ finding_id: 'home-link', choice: 'accept' }] });
  assert.equal(decided.action, 'complete');
  assert.equal(decided.classification.accepted.length, 3);
});

test('keeping a change without Spec work is offered only without rule impact', () => {
  const minor = evidence({ findings: [{ id: 'U-1', kind: 'unrequested_behavior', severity: 'major', summary: '링크', evidence: 'p.tsx:1', rule_impact: 'none' }] });
  const options = (run) => planRepairRound({ reviews: run.reviews }).user_questions[0].question.options.map((item) => item.id);
  assert.deepEqual(options(minor), ['reject', 'accept', 'adopt']);
  const rule = evidence({ findings: [{ id: 'U-2', kind: 'unrequested_behavior', severity: 'major', summary: '50건 상한', evidence: 'q.ts:1', rule_impact: 'business_rule' }] });
  assert.deepEqual(options(rule), ['reject', 'adopt']);
  const unmarked = evidence({ findings: [{ id: 'U-3', kind: 'unrequested_behavior', severity: 'major', summary: '표시 없음', evidence: 'q.ts:2' }] });
  assert.deepEqual(options(unmarked), ['reject', 'adopt']);
  const escalated = planRepairRound({ reviews: rule.reviews, scopeDecisions: [{ finding_id: 'U-2', choice: 'accept' }] });
  assert.equal(escalated.reason, 'scope_expansion');
  assert.equal(escalated.next_action, 'spec-me');
});

test('accepted findings let the review gate pass without repair', async () => {
  const { reviews, reviewInput } = evidence({ findings: [{ id: 'U-1', kind: 'unrequested_behavior', severity: 'major', summary: '링크', evidence: 'p.tsx:1', rule_impact: 'none' }] });
  const result = await runBoundedReviewRepair({ initialImplementation: { commit_sha: 'c1' }, initialReviews: reviews, reviewInput, scopeDecisions: [{ finding_id: 'U-1', choice: 'accept' }] });
  assert.equal(result.state, 'passed');
  assert.equal(result.reviews[0].state, 'passed');
  assert.equal(result.reviews[0].resolved_by_user[0].id, 'U-1');
});

test('scoped rules need intent and precision while plain rules do not', () => {
  const spec = [
    '- BR-12: 게시글 본문은 최대 5,000자다.',
    '- BR-13: 게시글이 삭제되면 모든 댓글도 함께 삭제된다.',
    '- BR-14: 계산기 홈 화면은 커뮤니티로 이동하는 링크를 제공한다.',
    '- BR-15: 공개 별명은 1–32자다.',
    '  - 의도: 표시 깨짐 방지',
    '  - 엄밀도: 플랫폼 기본 동작',
    '- BR-16: 이메일은 공개하지 않는다.',
  ].join('\n');
  assert.deepEqual(rulesMissingIntent(spec), ['BR-12', 'BR-13']);
});

test('a real delete propagation rule is recognized', () => {
  const rule = '- BR-13: 게시글이 삭제되면 그 게시글의 모든 댓글도 같은 작업에서 삭제 상태가 되어 공개 열람에서 제외되며 본문은 보존되지 않는다.';
  assert.deepEqual(rulesMissingIntent(rule), ['BR-13']);
  assert.deepEqual(rulesMissingIntent('- BR-3: 숨김·삭제된 콘텐츠는 일반 열람 결과에 포함하지 않는다.'), []);
});

test('an unrecorded value may be marked unknown instead of invented', () => {
  assert.deepEqual(rulesMissingIntent('BR-1: 최대 10건이다.\n- 의도: 미확인\n- 엄밀도: 플랫폼 기본 동작\n'), []);
});

test('a delegated decision needs a recorded user answer', () => {
  const decisions = [
    '| PD-1 | 5,000자 | 사용자 승인 (`spec-me-1/answers.json`) |',
    '| PD-2 | 댓글 삭제 | 사용자가 위임 (`spec-me-2/answers.json`) |',
    '| PD-13 | 댓글 동반 삭제 | 사용자가 Spec 결정에 위임 (feedback 항목 3) |',
    '| PD-14 | 알림 | 위임 없음, 사용자 승인 |',
  ].join('\n');
  assert.deepEqual(decisionsWithoutDelegation(decisions), ['PD-13']);
});

test('the Spec gate blocks completion on a missing rule intent', async () => {
  const root = await consumer();
  const { inspectSpecReviews } = await import('../.harness/src/workflow/spec-review.mjs');
  const { snapshotSpecReview } = await import('../.harness/src/workflow/spec-review.mjs');
  await mkdir(resolve(root, 'docs/specs/t'), { recursive: true });
  await writeFile(resolve(root, 'docs/specs/t/product-spec.md'), '- BR-1: 본문은 최대 10자다.\n');
  await writeFile(resolve(root, 'docs/specs/t/architecture-spec.md'), '# A\n');
  const inputs = await snapshotSpecReview({ root, ticketId: 't' });
  const reviews = { architecture: { axis: 'architecture', ticket_id: 't', reviewer_id: 'r', author_ids: ['w'], fork_turns: 'none', verdict: 'pass', findings: [], inputs } };
  const blocked = await inspectSpecReviews({ root, ticketId: 't', reviews });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /BR-1/);
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

test('malformed scope groups are rejected before any reservation', async () => {
  const root = await consumer();
  const { reviews, reviewInput } = evidence({ findings: [defect] });
  const input = { ...reviewInput, repository: root };
  const local = reviews.map((review) => ({ ...review, review_input: input }));
  const shared = [{ id: 'a', finding_ids: ['X', 'Y'] }, { id: 'b', finding_ids: ['Y', 'Z'] }];
  await assert.rejects(reserveImplementationRepair({ root, planId: 'community', reviewInput: input, reviews: local, scopeGroups: shared }), /one scope group only/);
  await assert.rejects(reserveImplementationRepair({ root, planId: 'community', reviewInput: input, reviews: local, scopeGroups: [{ id: 'a', finding_ids: ['X'] }] }), /at least two/);
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
