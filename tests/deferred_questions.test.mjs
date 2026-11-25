import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkStakeholderAnalysis, evaluateStakeholderAnalysisGate } from '../.harness/src/workflow/stakeholder-analysis-gate.mjs';

const request = '$orchestrator 지도에 장소를 보여 주는 기능 만들어줘';
const base = '# 분석\n\n| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 기능 |\n\n| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| 지도 | "지도에 장소를 보여 주는 기능" | REQUESTER | 확정 | 요청 원문 | - |\n';
const open = '\n### 미확정 사실\n\n| ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거 |\n|---|---|---|---|---|---|\n| OPEN-01 | 이용 조건 | 이용 주체 | 권한 | 확정 | 요청 원문 "지도에 장소를 보여 주는 기능" |\n';
const candidates = (...rows) => `\n## 4. 후보 요구사항\n\n| CAND | 제안자 | 종류 | 내용 | 요청 앵커 | 근거 | 결정 | 결정 출처 |\n|---|---|---|---|---|---|---|---|\n${rows.map(([id, decision, source = '']) => `| ${id} | LENS-DOMAIN | 업무 규칙 | 위치 정보가 없는 항목은 나타나지 않는다 | "장소" | 근거 | ${decision} | ${source} |`).join('\n')}\n`;
const analysis = (...rows) => base + open + candidates(...rows);
const codes = (text, options = {}) => checkStakeholderAnalysis({ request, analysis: text, status: 'completed', ...options }).errors.map(({ code }) => code);

test('a 보류(후속) row names what it waits on and none is left when the stage completes', () => {
  const deferred = analysis(['CAND-03', '보류(후속): 1번 질문의 장소 등록 여부 답에 달림']);
  assert.deepEqual(codes(deferred), ['DEFERRED_QUESTION_PENDING']);
  assert.deepEqual(codes(deferred, { status: 'action_required', questions: 1 }), []);
  assert.deepEqual(codes(analysis(['CAND-03', '보류(후속)']), { status: 'action_required', questions: 1 }), ['DEFERRED_TARGET_MISSING']);
  assert.deepEqual(codes(analysis(['CAND-03', '보류(후속)']), { status: 'action_required', questions: 1, legacyDeferred: true }), [], 'a deferral published before the target rule keeps its form');
  const openDeferred = base + open + '| OPEN-02 | 데이터 | 장소 출처 | 화면 | 보류(후속) | 1번 질문의 답에 달림 |\n' + candidates(['CAND-01', '채택', '`e1:1`']);
  assert.deepEqual(codes(openDeferred), ['DEFERRED_QUESTION_PENDING'], 'an OPEN row can be deferred too');
  assert.deepEqual(codes(openDeferred, { status: 'action_required', questions: 1 }), []);
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planSetId = '20260101-map';
  const write = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  const answered = async (execution, questions, answers) => {
    await write(`.io/runtime/executions/${execution}/result.json`, JSON.stringify({ questions }));
    await write(`.io/runtime/executions/${execution}/decision-answers.json`, JSON.stringify(answers));
  };
  const verdict = async (draft, { status = 'completed', previous = 'runtime/executions/e1/result.json' } = {}) => {
    await write(`.io/runtime/executions/e2/document-drafts/workspace/docs/specs/${planSetId}/stakeholder-analysis.md`, draft);
    const requirements = '# 요구사항\n\n출처: OPEN-01\n';
    await write(`.io/runtime/executions/e2/document-drafts/workspace/docs/specs/${planSetId}/requirements.md`, requirements);
    const result = await evaluateStakeholderAnalysisGate({ root, input: { skill: 'stakeholder-analysis', scope: request, session_directory: join(root, '.io'), context: { plan_set_id: planSetId, ...(previous ? { previous_result_ref: previous } : {}) } }, envelope: { status, code: status === 'completed' ? 'OK' : 'USER_DECISION_REQUIRED', result: { questions: status === 'completed' ? [] : [{}] } }, draftExecutionId: 'e2' });
    return result.errors.map(({ code }) => code);
  };
  return { root, planSetId, write, answered, verdict };
}
const published = analysis(['CAND-01', '채택', '`e1:1`'], ['CAND-03', '보류(후속): 1번 질문의 장소 등록 여부 답에 달림']);

test('a deferred row cannot vanish or be settled without a recorded answer about it', async (t) => {
  const { planSetId, write, answered, verdict } = await workspace(t);
  await write(`docs/specs/${planSetId}/stakeholder-analysis.md`, published);
  await answered('e1', [{ question_id: 'e1:1', title: '[제안: 도메인 전문가] 장소를 등록하는가', options: [{ id: 'a', label: '표시만 보기' }, { id: 'b', label: '사용자가 등록' }] }], [{ question_id: 'e1:1', answer: '표시만 보기' }]);
  await answered('e2', [{ question_id: 'e2:1', title: '[제안: 도메인 전문가] CAND-03 위치 없는 항목을 보여 주는가', options: [] }, { question_id: 'e2:2', title: '다른 질문' }], [{ question_id: 'e2:1', answer: '목록에 표시' }, { question_id: 'e2:2', answer: 'x' }]);
  const rows = (...deferred) => analysis(['CAND-01', '채택', '`e1:1`'], ...deferred);

  // The worker just flipped it to 보류 after the parent answer (a question that is not about it), or dropped it.
  assert.deepEqual(await verdict(rows(['CAND-03', '보류', '`e1:1`'])), ['DEFERRED_QUESTION_DROPPED']);
  assert.deepEqual(await verdict(rows(['CAND-03', '채택', 'answers.json'])), [], 'a bare answers.json reference cannot be resolved and is accepted');
  assert.deepEqual(await verdict(rows()), ['DEFERRED_QUESTION_DROPPED'], 'a vanished row');
  assert.deepEqual(await verdict(rows(['CAND-03', '보류', '`e9:1`'])), ['DEFERRED_QUESTION_DROPPED'], 'an id that is not in the recorded answers');
  assert.deepEqual(await verdict(rows(['CAND-03', '대기'])), ['DEFERRED_QUESTION_DROPPED'], 'completing with the question still unasked');
  // Asking it again is the way on: pending is fine when the stage returns its questions.
  assert.deepEqual(await verdict(rows(['CAND-03', '대기']), { status: 'action_required' }), []);
  // A recorded answer to a question about it settles it, in any decision form.
  assert.deepEqual(await verdict(rows(['CAND-03', '채택: 목록에 표시', '`e2:1`'])), []);
  assert.deepEqual(await verdict(rows(['CAND-03', '기각', '`e2:2`, `e2:1`'])), []);
  assert.deepEqual(await verdict(rows(['CAND-03', '기각', '`e2:2`'])), ['DEFERRED_QUESTION_DROPPED'], 'e2:2 is not about CAND-03');
  // A recorded answer that makes it moot, quoting the chosen option.
  assert.deepEqual(await verdict(rows(['CAND-03', '불필요 — e1:1: 표시만 보기 때문에 등록 항목이 없다'])), []);
  assert.deepEqual(await verdict(rows(['CAND-03', '불필요 — e1:1: 사용자가 등록 때문에 등록 항목이 없다'])), ['DEFERRED_QUESTION_DROPPED'], 'the chosen option is not the recorded answer');
  assert.deepEqual(await verdict(rows(['CAND-03', '불필요 — e8:1: 표시만 보기 때문에 등록 항목이 없다'])), ['DEFERRED_QUESTION_DROPPED'], 'the answer is not recorded');
  assert.deepEqual(await verdict(rows(['CAND-03', '불필요']), { status: 'action_required' }), ['DEFERRED_QUESTION_DROPPED'], 'the reason is required');
});

test('only a resume of a published analysis compares against it', async (t) => {
  const { planSetId, write, verdict } = await workspace(t);
  await write(`docs/specs/${planSetId}/stakeholder-analysis.md`, published);
  const dropped = analysis(['CAND-01', '채택', '`e1:1`']);
  assert.deepEqual(await verdict(dropped, { previous: null }), [], 'a first execution has nothing deferred before it');
  // A published deferral without a waiting target predates the rule: it still has to be asked, but needs no target.
  await write(`docs/specs/${planSetId}/stakeholder-analysis.md`, analysis(['CAND-03', '보류(후속)']));
  assert.deepEqual(await verdict(analysis(['CAND-03', '보류(후속)']), { status: 'action_required' }), []);
  assert.deepEqual(await verdict(analysis(['CAND-03', '보류']), { status: 'action_required' }), ['DEFERRED_QUESTION_DROPPED']);
});

test('an OPEN row that was deferred is settled with a recorded answer or as moot, like a candidate', async (t) => {
  const { planSetId, write, answered, verdict } = await workspace(t);
  const deferredOpen = base + open + '| OPEN-02 | 데이터 | 장소 출처 | 화면 | 보류(후속) | 1번 질문의 답에 달림 |\n' + candidates(['CAND-01', '채택', '`e1:1`']);
  await write(`docs/specs/${planSetId}/stakeholder-analysis.md`, deferredOpen);
  await answered('e1', [{ question_id: 'e1:1', title: '장소를 등록하는가', options: [{ id: 'a', label: '표시만 보기' }] }], [{ question_id: 'e1:1', answer: 'a' }]);
  await answered('e2', [{ question_id: 'e2:1', title: 'OPEN-02 장소는 어디서 오는가', options: [] }], [{ question_id: 'e2:1', answer: '고정 데이터' }]);
  const withOpen = (state, basis) => base + open + `| OPEN-02 | 데이터 | 장소 출처 | 화면 | ${state} | ${basis} |\n` + candidates(['CAND-01', '채택', '`e1:1`']);
  assert.deepEqual(await verdict(withOpen('확정', '`e2:1`')), []);
  assert.deepEqual(await verdict(withOpen('확정', '`e1:1`')), ['DEFERRED_QUESTION_DROPPED'], 'the parent answer is not an answer about OPEN-02');
  assert.deepEqual(await verdict(withOpen('해당 없음', '불편')), ['DEFERRED_QUESTION_DROPPED'], 'a 해당 없음 without the 불필요 form is no answer');
  assert.deepEqual(await verdict(withOpen('해당 없음', '불필요 — e1:1: 표시만 보기 때문에 등록하는 장소가 없다')), [], 'the answer id is mapped to the option label');
  assert.deepEqual(await verdict(withOpen('미정', ''), { status: 'action_required' }), []);
  assert.deepEqual(await verdict(withOpen('미정', '')), ['OPEN_FACT_UNRESOLVED', 'DEFERRED_QUESTION_DROPPED']);
});
