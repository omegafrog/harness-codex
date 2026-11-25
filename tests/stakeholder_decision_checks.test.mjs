import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQuestionContext, questionContextProblems, stakeholderQuestionProblems } from '../.harness/src/workflow/questions.mjs';
import { checkStakeholderAnalysis, evaluateStakeholderAnalysisGate } from '../.harness/src/workflow/stakeholder-analysis-gate.mjs';
import { compactQuestions } from '../.harness/src/workflow/stage-cli.mjs';
import { STAGE_CONTRACT } from '../.harness/src/installer/stage-contract.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const request = '$orchestrator 지도 기능 만들어. 핀을 올릴 수 있어야 해.';
const head = '# 분석\n\n| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 기능 |\n\n| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| 지도 | "지도 기능" | REQUESTER | 확정 | 요청 원문 | |\n\n### 미확정 사실\n\n| ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거 |\n|---|---|---|---|---|---|\n| OPEN-01 | 이용 조건 | 누가 쓰나 | 접근 | 확정 | 요청 원문 "지도 기능" |\n\n### 후보\n\n| CAND | 제안자 | 종류 | 내용 | 요청 앵커 | 근거 | 결정 | 결정 출처 |\n|---|---|---|---|---|---|---|---|\n';
const cand = (id, statement, decision = '대기') => `| ${id} | LENS-DOMAIN | 목표 | ${statement} | "지도 기능" | 근거 | ${decision} | |\n`;
const codes = (analysis, options = {}) => checkStakeholderAnalysis({ request, analysis, status: 'action_required', questions: 1, ...options }).errors.map(({ code }) => code);

test('a candidate that only defers the decision is rejected for a new analysis', () => {
  for (const text of ['지도 기능이 보여 주는 대상과 정보를 정한다', '완료 상태를 정한다.', '삭제 범위를 결정한다', '대상을 명확히 한다', '범위를 구체화한다', '공개 여부를 확인한다', '완료 조건을 정해야 한다.']) {
    assert.deepEqual(codes(head + cand('CAND-01', text)), ['CANDIDATE_DEFERS_DECISION'], text);
  }
  assert.deepEqual(codes(head + cand('CAND-01', '지도에는 공개로 표시한 핀만 이름과 함께 보인다') + cand('CAND-02', '핀 정보 범위: 이름만 보인다 / 이름과 설명이 보인다')), []);
  assert.deepEqual(codes(head + cand('CAND-01', '완료 상태를 정한다', '보류(후속)') + cand('CAND-02', '범위를 정한다', 'CAND-01에 병합')), [], 'a candidate that is not asked now is exempt');
  assert.deepEqual(codes(head + cand('CAND-01', '완료 상태를 정한다'), { legacyCandidates: true }), [], 'an older analysis keeps its candidates');
});

test('a resume keeps the deferring candidates the published analysis already had; a new analysis does not', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'defer-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planSetId = '20260101-map';
  await mkdir(join(root, 'docs/specs', planSetId), { recursive: true });
  const verdict = (context) => evaluateStakeholderAnalysisGate({ root, input: { skill: 'stakeholder-analysis', scope: request, context: { plan_set_id: planSetId, ...context } }, envelope: { status: 'action_required', code: 'USER_DECISION_REQUIRED', result: { questions: [{}] } } });
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), head + cand('CAND-01', '완료 상태를 정한다'));
  assert.deepEqual((await verdict({})).errors.map(({ code }) => code), ['CANDIDATE_DEFERS_DECISION']);
  assert.equal((await verdict({ previous_result_ref: 'runtime/executions/e1/result.json' })).ok, true);
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), head + cand('CAND-01', '핀은 올린 사람만 지울 수 있다'));
  assert.equal((await verdict({ previous_result_ref: 'runtime/executions/e1/result.json' })).ok, true);
});

const question = withDecisionContext({
  title: '[제안: 도메인 전문가(LENS-DOMAIN)] CAND-01 핀 정보', context: { settled_rules: ['지도에 핀이 보인다'], why_now: '보이는 정보가 있어야 한다' },
  options: [
    { id: 'a', label: '이름만 보인다', consequence: '이름', effect: '핀을 누르면 이름만 보인다', example: '핀 A는 "카페"만 보인다' },
    { id: 'b', label: '이름과 설명이 보인다', consequence: '이름과 설명', effect: '핀을 누르면 이름과 설명이 보인다', example: '핀 A는 "카페"와 설명이 보인다' },
  ],
  recommended_option_id: 'a', rationale: '요청은 핀 이름만 말한다',
});

test('stakeholder-analysis questions reject deferring options, bare adopt/reject on merged candidates and a missing reason', () => {
  assert.deepEqual(stakeholderQuestionProblems(question), []);
  const withOption = (change) => ({ ...question, options: question.options.map((option, index) => ({ ...option, ...(index ? change : {}) })) });
  for (const text of ['구현자가 임의로 정한다', '나중에 정한다', '후속 질문에서 다시 묻는다', '후속 단계에서 정한다', '후속에서 묻는다']) {
    assert.match(stakeholderQuestionProblems(withOption({ effect: text })).join(), /every option settles/, text);
    assert.match(stakeholderQuestionProblems(withOption({ example: text })).join(), /every option settles/, text);
  }
  const hold = withOption({ label: '보류', effect: '후속 질문에서 다시 묻는다' });
  assert.deepEqual(stakeholderQuestionProblems(hold), [], 'a 보류 option may say it is asked again');
  assert.match(stakeholderQuestionProblems(withOption({ label: '보류', effect: '임의로 정한다' })).join(), /every option settles/);
  const adopt = { ...question, title: '[제안: A] CAND-01, CAND-02 지도 정보', options: [{ ...question.options[0], label: '채택' }, { ...question.options[1], label: '기각' }] };
  assert.match(stakeholderQuestionProblems(adopt).join(), /several CAND IDs/);
  assert.deepEqual(stakeholderQuestionProblems({ ...adopt, title: '[제안: A] CAND-01 지도 정보' }), []);
  assert.deepEqual(stakeholderQuestionProblems({ ...adopt, title: '[제안: A] CAND-01, CAND-02 지도 정보', options: question.options }), []);
  assert.match(stakeholderQuestionProblems({ ...question, rationale: '' }).join(), /rationale/);
  assert.match(stakeholderQuestionProblems({ ...question, rationale: '첫째\n둘째' }).join(), /rationale/);
  assert.match(stakeholderQuestionProblems({ ...question, rationale: '가'.repeat(161) }).join(), /rationale/);
  assert.deepEqual(stakeholderQuestionProblems({ ...question, recommended_option_id: undefined, rationale: '' }), [], 'no recommendation, no reason needed');
});

test('the stakeholder checks run only for stakeholder-analysis and only against a schema that has the context', () => {
  const bad = { ...question, options: question.options.map((option, index) => (index ? { ...option, effect: '구현자가 임의로 정한다' } : option)) };
  assert.throws(() => assertQuestionContext([bad], { skill: 'stakeholder-analysis' }), /every option settles/);
  assert.doesNotThrow(() => assertQuestionContext([bad], { skill: 'event-storming' }));
  assert.doesNotThrow(() => assertQuestionContext([bad], { skill: 'stakeholder-analysis', schema: { properties: { result: { properties: { questions: { items: { properties: {} } } } } } } }), 'an execution started before the rule is accepted');
});

test('an option is never a direct-input or other choice', () => {
  for (const label of ['직접 입력', '직접 입력한다', '기타', 'other', 'Other']) {
    const asked = { ...question, options: question.options.map((option, index) => (index ? { ...option, label } : option)) };
    assert.match(questionContextProblems(asked).join(), /names the concrete values/, label);
  }
  assert.deepEqual(questionContextProblems(question), []);
});

test('the compact questions show each example and the reason for the recommendation', () => {
  const [shown] = compactQuestions([{ question_id: 'e:1', ...question }]);
  assert.equal(shown.reason, question.rationale);
  assert.deepEqual(shown.options.map((option) => option.example), question.options.map((option) => option.example));
  assert.equal(compactQuestions([{ question_id: 'e:1', ...question, recommended_option_id: undefined }])[0].reason, undefined);
});

test('the stage contract and GUIDEs state the new rules', async () => {
  assert.match(STAGE_CONTRACT, /never a `직접 입력`, `기타` or `other` option/);
  assert.match(STAGE_CONTRACT, /reason in `rationale`, one line/);
  assert.match(STAGE_CONTRACT, /Make no tool call that does nothing/);
  const read = (path) => readFile(join(repo, path), 'utf8');
  const persona = await read('.harness/internal-skills/stakeholder-persona/GUIDE.md');
  assert.match(persona, /"options": \[/);
  assert.match(persona, /"preferred": 0/);
  assert.match(persona, /Never write a statement that only says something is to be decided/);
  const analysis = await read('.harness/internal-skills/stakeholder-analysis/GUIDE.md');
  for (const part of ['persona_binding', '채택: <option label>', '보류(후속)', 'ONE question', 'least new behavior']) assert.ok(analysis.includes(part), part);
  const storming = await read('.harness/internal-skills/event-storming/GUIDE.md');
  for (const part of ['persona_binding', 'do not read that file yourself', '직접 입력']) assert.ok(storming.includes(part), part);
  assert.match(await read('docs/architecture/enforcement.md'), /CANDIDATE_DEFERS_DECISION/);
});
