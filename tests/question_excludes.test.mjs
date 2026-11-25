import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerConflictMessage, assertQuestionContext, questionBatchProblems, stakeholderExclusionProblems } from '../.harness/src/workflow/questions.mjs';
import { mapReplyToAnswers } from '../.harness/src/workflow/answer-text.mjs';
import { validateOutputFormat } from '../.harness/src/workflow/output-schema.mjs';
import { checkStakeholderAnalysis } from '../.harness/src/workflow/stakeholder-analysis-gate.mjs';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const REQUEST = '게시글 삭제 기능을 추가해줘';
// Options are { id, label, ex?: [[question, option], ...] }; the first option is recommended unless `rec` is given.
const ask = (title, options, rec = options[0].id) => withDecisionContext({
  title, recommended_option_id: rec, rationale: '근거', decision_kind: null,
  options: options.map(({ id, label, ex = [], effect }) => ({ id, label, consequence: label, evidence: [], ...(effect ? { effect } : {}), excludes: ex.map(([question, option]) => ({ question, option })) })),
});
const batchOf = (...questions) => questions.map((question, index) => ({ ...question, question_id: `q:${index + 1}` }));

test('the stored and flow schemas carry excludes as optional, integer-typed and strict', async () => {
  for (const name of ['question.schema.json', 'flows/common.schema.json', 'flows/plan-review.schema.json', 'flows/spec-review.schema.json']) {
    const schema = JSON.parse(await readFile(join(root, '.harness/schemas', name), 'utf8'));
    const option = (schema.properties.questions?.items ?? schema).properties.options.items;
    assert.equal(option.required.includes('excludes'), false, `${name}: optional in the stored schema`);
    assert.deepEqual([option.properties.excludes.items.type, option.properties.excludes.items.required, option.properties.excludes.items.additionalProperties], ['object', ['question', 'option'], false], name);
    assert.equal(option.properties.excludes.items.properties.question.type, 'integer', name);
  }
  const schema = JSON.parse(await readFile(join(root, '.harness/schemas/question.schema.json'), 'utf8'));
  const base = { question_id: 'x:1', title: 't', recommended_option_id: 'a', rationale: 'r', options: [{ id: 'a', label: 'a', consequence: 'c' }, { id: 'b', label: 'b', consequence: 'c', excludes: [{ question: 2, option: 'a' }] }] };
  assert.deepEqual(validateOutputFormat(base, schema).errors, []);
  const wrong = (excludes) => validateOutputFormat({ ...base, options: [{ ...base.options[0], excludes }, base.options[1]] }, schema).errors.map(({ path }) => path);
  assert.deepEqual(wrong([{ question: 1.5, option: 'a' }]), ['$.options[0].excludes[0].question']);
  assert.deepEqual(wrong([{ question: '2', option: 'a' }]), ['$.options[0].excludes[0].question']);
  assert.deepEqual(wrong([{ question: 2, option: 'a', extra: 1 }]), ['$.options[0].excludes[0].extra']);
});

test('the installed stage output schema requires excludes on every option and finish refuses a batch without it', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const begun = await flow.beginStage('stakeholder-analysis');
  const schema = JSON.parse(await readFile(begun.started.schema_path, 'utf8'));
  const option = schema.properties.result.properties.questions.items.properties.options.items;
  assert.ok(option.required.includes('excludes'));
  assert.deepEqual(option.properties.excludes.items.required, ['question', 'option']);
  const questions = [ask('질문 하나', [{ id: 'a', label: '가' }, { id: 'b', label: '나' }]), ask('질문 둘', [{ id: 'a', label: '다' }, { id: 'b', label: '라' }])]
    .map((question) => ({ ...question, options: question.options.map(({ excludes, ...rest }) => rest) }));
  await flow.submitStage(begun, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', files: { [flow.specPath('stakeholder-analysis.md')]: stakeholderAnalysisDocument(REQUEST) }, questions: questions.map((question, index) => ({ question_id: `q${index}`, ...question })) });
  const refused = flow.finishStage(begun);
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).status, 'format_error');
  assert.ok(JSON.parse(refused.stdout).errors.some(({ path, missing }) => missing && path.endsWith('.excludes')));
});

test('the batch check rejects bad references, contradicting recommendations, dead options and dependent questions', () => {
  const plain = [ask('A', [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }])];
  assert.deepEqual(questionBatchProblems(plain), []);
  assert.deepEqual(questionBatchProblems([]), []);
  const withRef = (...refs) => [ask('A', [{ id: 'x', label: 'X', ex: refs }, { id: 'y', label: 'Y' }]), plain[1]];
  assert.match(questionBatchProblems(withRef([3, 'x'])).join(), /question 1 option x excludes question 3, which is not a question position/);
  assert.match(questionBatchProblems(withRef([1, 'y'])).join(), /excludes an option of its own question/);
  assert.match(questionBatchProblems(withRef([2, 'zzz'])).join(), /question 2 option zzz, which does not exist/);
  assert.match(questionBatchProblems([{ ...plain[0], options: plain[0].options.map(({ excludes, ...rest }) => rest) }, plain[1]]).join(), /question 1 option x needs excludes/);

  // The recommended options of the batch must not exclude each other; either side may declare the pair.
  const clash = (declaredOn) => [ask('본인 장소만', [{ id: 'own', label: '본인 장소', ex: declaredOn === 1 ? [[2, 'open']] : [] }, { id: 'all', label: '전체' }]), ask('로그인 없이', [{ id: 'open', label: '누구나', ex: declaredOn === 2 ? [[1, 'own']] : [] }, { id: 'login', label: '로그인' }])];
  for (const side of [1, 2]) {
    const found = questionBatchProblems(clash(side));
    assert.match(found.join(), /recommended question 1 option own \("본인 장소"\) and the recommended question 2 option open \("누구나"\) cannot both hold/, `declared on question ${side}`);
    assert.match(found.join(), /defer/);
  }
  // A declared pair that is not recommended together is only recorded.
  const quiet = [ask('A', [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z', ex: [[2, 'y']] }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }, { id: 'z', label: 'Z2' }])];
  assert.deepEqual(questionBatchProblems(quiet), []);

  // An option that every option of another question excludes is dead.
  const dead = [ask('A', [{ id: 'x', label: 'X', ex: [[2, 'y']] }, { id: 'y', label: 'Y', ex: [[2, 'y']] }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }])];
  assert.match(questionBatchProblems(dead).join(), /question 2 option y \("Y2"\) is excluded by every option of question 1/);

  // A question left with one option by another question's recommendation is dependent: ask it after the answer.
  const dependent = [ask('A', [{ id: 'x', label: 'X', ex: [[2, 'y'], [2, 'z']] }, { id: 'y', label: 'Y' }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }, { id: 'z', label: 'Z2' }])];
  const found = questionBatchProblems(dependent).join();
  assert.match(found, /question 2 is decided by the recommended answers of other questions \(only question 2 option x \("X2"\) remains\); ask it after the answer \(defer it\)/);
  // Two of three remaining is still a real question.
  assert.deepEqual(questionBatchProblems([ask('A', [{ id: 'x', label: 'X', ex: [[2, 'z']] }, { id: 'y', label: 'Y' }]), dependent[1]]), []);
});

test('assertQuestionContext runs the batch check only for a schema that has excludes, and always when no schema is given', () => {
  const clash = [ask('A', [{ id: 'x', label: 'X', ex: [[2, 'x']] }, { id: 'y', label: 'Y' }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }])];
  const shape = (options) => ({ properties: { result: { properties: { questions: { items: { properties: { context: {}, options: { items: { properties: options } } } } } } } } });
  assert.throws(() => assertQuestionContext(clash), /cannot both hold[\s\S]*`excludes` of an option lists/);
  assert.throws(() => assertQuestionContext(clash, { schema: shape({ excludes: {} }) }), /cannot both hold/);
  assert.doesNotThrow(() => assertQuestionContext(clash, { schema: shape({ effect: {} }) }), 'a schema without excludes predates the rule');
  assert.doesNotThrow(() => assertQuestionContext([clash[1], clash[1]]));
});

test('stakeholder-analysis: identity-limited options and no-login options must be declared as excluding each other', () => {
  const own = (ex = []) => ask('[BIZ-01] 어떤 장소를 보여 주나요?', [{ id: 'own', label: '본인이 등록한 장소만', ex }, { id: 'all', label: '모든 장소' }], 'all');
  const access = (ex = []) => ask('[OPEN-01] 누가 쓰나요?', [{ id: 'open', label: '로그인 없이 누구나', ex }, { id: 'member', label: '로그인한 사용자' }]);
  assert.match(stakeholderExclusionProblems([own(), access()]).join(), /question 1 option own[\s\S]*cannot hold with question 2 option open[\s\S]*excludes: \[\{question: 2, option: "open"\}\]/);
  assert.deepEqual(stakeholderExclusionProblems([own([[2, 'open']]), access()]), [], 'declared on either side');
  assert.deepEqual(stakeholderExclusionProblems([own(), access([[1, 'own']])]), []);
  // Not matched: no identity limit, a login-required access answer, or both wordings in one question.
  assert.deepEqual(stakeholderExclusionProblems([ask('A', [{ id: 'a', label: '모든 장소' }, { id: 'b', label: '최근 장소' }]), access()]), []);
  assert.deepEqual(stakeholderExclusionProblems([own(), ask('B', [{ id: 'member', label: '로그인한 사용자만' }, { id: 'staff', label: '관리자만' }])]), []);
  assert.deepEqual(stakeholderExclusionProblems([ask('A', [{ id: 'own', label: '본인 장소만' }, { id: 'open', label: '로그인 없이 누구나' }])]), []);
  assert.deepEqual(stakeholderExclusionProblems([ask('A', [{ id: 'a', label: '일주일 내 장소' }, { id: 'b', label: '전체' }]), access()]), [], '"내" inside a word is not the viewer');
  assert.ok(stakeholderExclusionProblems([ask('A', [{ id: 'a', label: '내 장소만' }, { id: 'b', label: '전체' }]), access()]).length, '내 장소 limits by the viewer');
  // Only stakeholder-analysis runs it.
  assert.doesNotThrow(() => assertQuestionContext([own(), access()], { skill: 'event-storming' }));
  assert.throws(() => assertQuestionContext([own(), access()], { skill: 'stakeholder-analysis' }), /cannot hold with question 2 option open/);
});

test('stakeholder-analysis: user registration options and view-only options must be declared as excluding each other', () => {
  const register = (ex = []) => ask('[CAND-01] 장소는 누가 만드나요?', [{ id: 'user', label: '사용자가 등록', ex }, { id: 'staff', label: '운영자가 등록' }]);
  const done = (ex = []) => ask('[BIZ-02] 완료 조건은?', [{ id: 'view', label: '표시만 보기', ex }, { id: 'edit', label: '지도에서 확인한다' }]);
  assert.match(stakeholderExclusionProblems([register(), done()]).join(), /question 1 option user[\s\S]*register\/edit content[\s\S]*question 2 option view/);
  assert.deepEqual(stakeholderExclusionProblems([register([[2, 'view']]), done()]), []);
  assert.deepEqual(stakeholderExclusionProblems([register(), done([[1, 'user']])]), []);
  assert.deepEqual(stakeholderExclusionProblems([ask('A', [{ id: 'staff', label: '운영자가 등록' }, { id: 'x', label: '준비된 항목' }]), done()]), [], 'only users registering is matched');
  assert.deepEqual(stakeholderExclusionProblems([ask('A', [{ id: 'no', label: '사용자는 등록하지 않는다' }, { id: 'x', label: '준비된 항목' }]), done()]), [], 'a negated registration is not matched');
  assert.deepEqual(stakeholderExclusionProblems([register(), ask('B', [{ id: 'a', label: '목록으로 보여 준다' }, { id: 'b', label: '지도로 보여 준다' }])]), []);
  // The E2E batch: own places + anyone + users register + view only.
  const batch = [ask('Q1', [{ id: 'own', label: '본인이 등록한 장소만' }, { id: 'all', label: '모든 장소' }]), ask('Q2', [{ id: 'open', label: '로그인 없이 누구나' }, { id: 'member', label: '로그인한 사용자' }]), register(), done()];
  assert.ok(stakeholderExclusionProblems(batch).length >= 3);
});

test('the gate asks for a recommended-combination scenario with two or more questions, except for a resume of an older analysis', () => {
  const head = '# 분석\n\n| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 기능 |\n\n| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| 지도 | "지도" | REQUESTER | 확정 | 요청 원문 | - |\n\n| ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거 |\n|---|---|---|---|---|---|\n| OPEN-01 | 이용 조건 | 누가 쓰나 | 접근 | 해당 없음 | 화면이 없다 |\n';
  const codes = (analysis, options = {}) => checkStakeholderAnalysis({ request: '지도 만들어', analysis, status: 'action_required', questions: 2, ...options }).errors.map(({ code }) => code);
  assert.deepEqual(codes(head), ['RECOMMENDED_SCENARIO_MISSING']);
  assert.deepEqual(codes(`${head}\n- 추천 조합 시나리오:   \n`), ['RECOMMENDED_SCENARIO_MISSING'], 'an empty value is missing');
  assert.deepEqual(codes(`${head}\n- 추천 조합 시나리오: 방문자는 로그인 없이 준비된 장소를 본다. 등록은 없다.\n`), []);
  assert.deepEqual(codes(head, { questions: 1 }), [], 'one question has no combination');
  assert.deepEqual(codes(head, { status: 'completed' }), []);
  assert.deepEqual(codes(head, { legacyScenario: true }), [], 'a resume of an analysis written before the line');
});

test('a reply that picks two options which cannot both hold records nothing, by letter, by number and as "추천대로"', () => {
  const two = batchOf(
    ask('어떤 장소를 보여 주나요?', [{ id: 'a', label: '본인 장소', ex: [[2, 'a']] }, { id: 'b', label: '모든 장소' }], 'b'),
    ask('누가 쓰나요?', [{ id: 'a', label: '누구나' }, { id: 'b', label: '로그인한 사용자' }], 'b'),
  );
  const refused = mapReplyToAnswers(two, '1번 A, 2번 A');
  assert.equal(refused.answers, undefined);
  assert.match(refused.clarification, /질문 1\("어떤 장소를 보여 주나요\?"\)의 "본인 장소"과\(와\) 질문 2\("누가 쓰나요\?"\)의 "누구나"은\(는\) 함께 성립할 수 없습니다/);
  assert.match(refused.clarification, /아무것도 기록하지 않았습니다/);
  assert.match(mapReplyToAnswers(two, '1: a, 2: a').clarification, /함께 성립할 수 없습니다/);
  assert.match(mapReplyToAnswers(two, '1번 본인 장소\n2번 누구나').clarification, /함께 성립할 수 없습니다/);
  assert.deepEqual(mapReplyToAnswers(two, '1번 B, 2번 A').answers.map(({ answer }) => answer), ['모든 장소 (b)', '누구나 (a)']);
  assert.deepEqual(mapReplyToAnswers(two, '추천대로').answers.length, 2);
  // A partial reply counts the answers already stored; "추천대로" fills the rest with recommended options.
  const stored = [{ question_id: 'q:1', answer: '본인 장소 (a)' }];
  const rest = mapReplyToAnswers([{ ...two[0] }, { ...two[1], recommended_option_id: 'a' }], '추천대로', { answered: ['q:1'], stored });
  assert.match(rest.clarification, /함께 성립할 수 없습니다/);
  assert.deepEqual(mapReplyToAnswers(two, '2번 B', { answered: ['q:1'], stored }).answers, [{ question_id: 'q:2', answer: '로그인한 사용자 (b)' }]);
  assert.match(mapReplyToAnswers(two, '2번 A', { answered: ['q:1'], stored }).clarification, /함께 성립할 수 없습니다/);
  // The user's own words are not an option and are not checked; neither is a batch without excludes.
  assert.deepEqual(mapReplyToAnswers(two, '1번 A, 2번 가입은 필요').answers.length, 2);
  assert.equal(answerConflictMessage(two, [{ question_id: 'q:1', answer: '본인이든 누구든' }, { question_id: 'q:2', answer: '누구나 (a)' }]), null);
  assert.equal(answerConflictMessage(two.map((question) => ({ ...question, options: question.options.map(({ excludes, ...rest }) => rest) })), [{ question_id: 'q:1', answer: '본인 장소 (a)' }, { question_id: 'q:2', answer: '누구나 (a)' }]), null);
});

test('answer --text and launch --answer refuse a conflicting choice and record nothing; a compatible one goes through', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace } = flow;
  const native = (...args) => spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), ...args], { cwd: workspace, encoding: 'utf8' });
  const begun = await flow.beginStage('stakeholder-analysis');
  const questions = [
    ask('공개 단위는?', [{ id: 'a', label: '핀 하나씩' }, { id: 'b', label: '소유자 묶음', ex: [[2, 'b']] }]),
    ask('복구는?', [{ id: 'a', label: '복구 없음' }, { id: 'b', label: '7일 복구' }]),
  ];
  await flow.submitStage(begun, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', files: { [flow.specPath('stakeholder-analysis.md')]: stakeholderAnalysisDocument(REQUEST) }, questions: questions.map((question, index) => ({ question_id: `q${index}`, ...question })) });
  const finished = flow.finishStage(begun);
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  const waiting = JSON.parse(finished.stdout);
  const [first, second] = waiting.result.questions;
  const pending = join(workspace, '.io/runtime/executions', waiting.execution_id, 'pending-answers.json');

  const text = native('answer', '--text', '1번 B, 2번 B');
  assert.equal(text.status, 0, text.stderr);
  const clarification = JSON.parse(text.stdout);
  assert.equal(clarification.status, 'clarification_needed');
  assert.match(clarification.message, /함께 성립할 수 없습니다/);
  assert.equal(existsSync(pending), false, 'nothing was recorded');

  const direct = native('launch', '--stage-id', 'stakeholder-analysis', '--answer', JSON.stringify([{ question_id: first.question_id, answer: '소유자 묶음 (b)' }, { question_id: second.question_id, answer: '7일 복구 (b)' }]));
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).status, 'clarification_needed');
  assert.equal(existsSync(pending), false, 'launch --answer recorded nothing either');

  const partial = native('answer', '--text', '2번 B');
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(JSON.parse(partial.stdout).waiting_for_answers, true);
  const stored = JSON.parse(await readFile(pending, 'utf8'));
  // The stored answer now conflicts with the choice a later reply makes.
  const later = native('answer', '--text', '1번 B');
  assert.equal(JSON.parse(later.stdout).status, 'clarification_needed');
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), stored, 'the stored answers are unchanged');
  const viaJson = native('launch', '--stage-id', 'stakeholder-analysis', '--answer', JSON.stringify([{ question_id: first.question_id, answer: '소유자 묶음 (b)' }]));
  assert.equal(JSON.parse(viaJson.stdout).status, 'clarification_needed');
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), stored);
});
