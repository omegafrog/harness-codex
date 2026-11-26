import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerConflictMessage, assertQuestionContext, declaredExclusions, droppedExclusionProblems, questionBatchProblems } from '../.harness/src/workflow/questions.mjs';
import { declaredAnswers } from '../.harness/src/workflow/answer-text.mjs';
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

  // A question another recommendation narrows to one option is a legitimate content-first question: no rule rejects it.
  assert.deepEqual(questionBatchProblems([ask('A', [{ id: 'x', label: 'X', ex: [[2, 'y'], [2, 'z']] }, { id: 'y', label: 'Y' }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }, { id: 'z', label: 'Z2' }])]), []);
});

test('a resubmission keeps the excludes pairs an earlier rejected submission declared', () => {
  const batch = (declared, bOptions = [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }]) => [ask('A', [{ id: 'x', label: 'X', ex: declared ? [[2, 'y']] : [] }, { id: 'y', label: 'Y' }], 'y'), ask('B', bOptions, 'x')];
  const earlier = declaredExclusions(batch(true));
  assert.equal(earlier.length, 1);
  assert.deepEqual(droppedExclusionProblems(batch(false), null), [], 'first submission is unaffected');
  assert.match(droppedExclusionProblems(batch(false), earlier).join(), /question 1 option x \("X"\) and question 2 option y \("Y2"\) cannot hold together[\s\S]*restore that excludes declaration/);
  assert.deepEqual(droppedExclusionProblems(batch(true), earlier), [], 'kept');
  const other = batch(false);
  other[1].options[1].excludes = [{ question: 1, option: 'x' }];
  assert.deepEqual(droppedExclusionProblems(other, earlier), [], 'declared from the other side');
  assert.deepEqual(droppedExclusionProblems(batch(false, [{ id: 'x', label: 'X2' }, { id: 'z', label: 'Z2' }]), earlier), [], 'the option was removed');
  assert.deepEqual(droppedExclusionProblems(batch(false, [{ id: 'x', label: 'X2' }, { id: 'q', label: 'Y2' }]), earlier).length, 1, 'matched by label when the id changed, so it must still be declared');
  assert.throws(() => assertQuestionContext(batch(false), { previousExclusions: earlier }), /restore that excludes declaration/);
  // A pair whose option was dead is not kept: dropping it fixes that rejection.
  const dead = [ask('A', [{ id: 'x', label: 'X', ex: [[2, 'y']] }, { id: 'y', label: 'Y', ex: [[2, 'y']] }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }])];
  assert.deepEqual(declaredExclusions(dead), []);
});

test('assertQuestionContext runs the batch check only for a schema that has excludes, and always when no schema is given', () => {
  const clash = [ask('A', [{ id: 'x', label: 'X', ex: [[2, 'x']] }, { id: 'y', label: 'Y' }]), ask('B', [{ id: 'x', label: 'X2' }, { id: 'y', label: 'Y2' }])];
  const shape = (options) => ({ properties: { result: { properties: { questions: { items: { properties: { context: {}, options: { items: { properties: options } } } } } } } } });
  assert.throws(() => assertQuestionContext(clash), /cannot both hold[\s\S]*`excludes` of an option lists/);
  assert.throws(() => assertQuestionContext(clash, { schema: shape({ excludes: {} }) }), /cannot both hold/);
  assert.doesNotThrow(() => assertQuestionContext(clash, { schema: shape({ effect: {} }) }), 'a schema without excludes predates the rule');
  assert.doesNotThrow(() => assertQuestionContext([clash[1], clash[1]]));
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

test('declared options which cannot both hold record nothing, as choices and as recommended', () => {
  const two = batchOf(
    ask('어떤 장소를 보여 주나요?', [{ id: 'a', label: '본인 장소', ex: [[2, 'a']] }, { id: 'b', label: '모든 장소' }], 'b'),
    ask('누가 쓰나요?', [{ id: 'a', label: '누구나' }, { id: 'b', label: '로그인한 사용자' }], 'b'),
  );
  const picks = (...ids) => ids.map(([n, option_id]) => ({ question_id: `q:${n}`, option_id }));
  const refused = declaredAnswers(two, { choices: picks([1, 'a'], [2, 'a']) });
  assert.equal(refused.answers, undefined);
  assert.match(refused.clarification, /질문 1\("어떤 장소를 보여 주나요\?"\)의 "본인 장소"과\(와\) 질문 2\("누가 쓰나요\?"\)의 "누구나"은\(는\) 함께 성립할 수 없습니다/);
  assert.match(refused.clarification, /아무것도 기록하지 않았습니다/);
  assert.deepEqual(declaredAnswers(two, { choices: picks([1, 'b'], [2, 'a']) }).answers.map(({ answer }) => answer), ['모든 장소 (b)', '누구나 (a)']);
  assert.equal(declaredAnswers(two, { recommended: true }).answers.length, 2);
  // A partial reply counts the answers already stored; "recommended" fills the rest with recommended options.
  const stored = [{ question_id: 'q:1', answer: '본인 장소 (a)' }];
  const rest = declaredAnswers([{ ...two[0] }, { ...two[1], recommended_option_id: 'a' }], { recommended: true, answered: ['q:1'], stored });
  assert.match(rest.clarification, /함께 성립할 수 없습니다/);
  assert.deepEqual(declaredAnswers(two, { choices: picks([2, 'b']), answered: ['q:1'], stored }).answers, [{ question_id: 'q:2', answer: '로그인한 사용자 (b)' }]);
  assert.match(declaredAnswers(two, { choices: picks([2, 'a']), answered: ['q:1'], stored }).clarification, /함께 성립할 수 없습니다/);
  // The user's own words are not an option and are not checked; neither is a batch without excludes.
  assert.equal(declaredAnswers(two, { choices: [{ question_id: 'q:1', option_id: 'a' }, { question_id: 'q:2', text: '가입은 필요' }] }).answers.length, 2);
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

  const pick = (question, option_id) => ({ question_id: question.question_id, option_id });
  const reply = (words, ...choices) => native('answer', '--text', words, '--choices', JSON.stringify(choices));
  const text = reply('1번 B, 2번 B', pick(first, 'b'), pick(second, 'b'));
  assert.equal(text.status, 0, text.stderr);
  const clarification = JSON.parse(text.stdout);
  assert.equal(clarification.status, 'clarification_needed');
  assert.match(clarification.message, /함께 성립할 수 없습니다/);
  assert.equal(existsSync(pending), false, 'nothing was recorded');

  const direct = native('launch', '--stage-id', 'stakeholder-analysis', '--answer', JSON.stringify([{ question_id: first.question_id, answer: '소유자 묶음 (b)' }, { question_id: second.question_id, answer: '7일 복구 (b)' }]));
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).status, 'clarification_needed');
  assert.equal(existsSync(pending), false, 'launch --answer recorded nothing either');

  const partial = reply('2번 B', pick(second, 'b'));
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(JSON.parse(partial.stdout).waiting_for_answers, true);
  const stored = JSON.parse(await readFile(pending, 'utf8'));
  // The stored answer now conflicts with the choice a later reply makes.
  const later = reply('1번 B', pick(first, 'b'));
  assert.equal(JSON.parse(later.stdout).status, 'clarification_needed');
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), stored, 'the stored answers are unchanged');
  const viaJson = native('launch', '--stage-id', 'stakeholder-analysis', '--answer', JSON.stringify([{ question_id: first.question_id, answer: '소유자 묶음 (b)' }]));
  assert.equal(JSON.parse(viaJson.stdout).status, 'clarification_needed');
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), stored);
});
