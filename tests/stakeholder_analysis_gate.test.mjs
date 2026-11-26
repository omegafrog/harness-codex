import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStakeholderAnalysis, evaluateStakeholderAnalysisGate } from '../.harness/src/workflow/stakeholder-analysis-gate.mjs';
import { checkRequirementsDocument, evaluateRequirementsDocumentGate } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { finishNext } from '../.harness/src/workflow/stage-cli.mjs';

const request = '$orchestrator 커뮤니티 기능 만들어. 게시글을 쓸 수 있어야 해.';
const base = '# 분석\n\n| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 기능 |\n\n| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| 커뮤니티 | "커뮤니티 기능" | REQUESTER | 확정 | 요청 원문 | - |\n';
const header = '\n### 미확정 사실\n\n| ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거 |\n|---|---|---|---|---|---|\n';
const row = (id, kind, state, basis = '') => `| ${id} | ${kind} | 사실 | 동작 | ${state} | ${basis} |\n`;
const doc = (...rows) => base + header + rows.join('');
const codes = (analysis, options = {}) => checkStakeholderAnalysis({ request, analysis, ...options }).errors.map(({ code }) => code);
const access = row('OPEN-01', '이용 조건', '확정', '요청 원문 "커뮤니티 기능"');

test('a new analysis needs the 미확정 사실 table with an 이용 조건 row', () => {
  assert.deepEqual(codes(doc(access), { status: 'completed' }), []);
  assert.deepEqual(codes(base, { status: 'completed' }), ['OPEN_FACTS_MISSING']);
  assert.deepEqual(codes(doc(row('OPEN-01', '데이터', '확정', '요청 원문 "게시글"')), { status: 'completed' }), ['OPEN_FACT_ACCESS_MISSING']);
  assert.deepEqual(codes(doc(row('OPEN-01', '이용 조건', '해당 없음', '화면이 없는 배치 작업이다')), { status: 'completed' }), []);
  assert.deepEqual(codes(doc(row('OPEN-01', '이용 조건', '해당 없음')), { status: 'completed' }), ['OPEN_FACT_INVALID']);
  assert.ok(checkStakeholderAnalysis({ request, analysis: '# 분석\n\n- 판정: 생략\n' }).ok, 'a skipped analysis is not checked');
});

test('처리 and 근거 are validated', () => {
  const bad = (...rows) => codes(doc(access, ...rows), { status: 'completed' });
  assert.deepEqual(bad(row('OPEN-02', '권한', '보류')), ['OPEN_FACT_INVALID']);
  assert.deepEqual(bad(row('OPEN-02', '권한', '확정', '요청 원문 "없는 문장"')), ['OPEN_FACT_INVALID']);
  assert.deepEqual(bad(row('OPEN-02', '권한', '확정', '에이전트 판단')), ['OPEN_FACT_INVALID']);
  assert.deepEqual(bad(row('OPEN-02', '권한', '확정', 'docs/missing.md')), ['OPEN_FACT_INVALID'].slice(0, 0), 'no root, no existence check');
  assert.deepEqual(bad(row('OPEN-02', '기타종류', '확정', 'answers.json')), ['OPEN_FACT_INVALID']);
  assert.deepEqual(bad(row('OPEN-02', '권한', '확정', '`exec-1:3`'), row('OPEN-03', '데이터', '확정', 'answers.json')), []);
  assert.deepEqual(codes(doc(access, row('OPEN-02', '권한', '확정', 'docs/missing.md')), { status: 'completed', root: tmpdir() }), ['OPEN_FACT_INVALID']);
});

test('미정 rows block completion but are allowed with a question on action_required', () => {
  const open = doc(access, row('OPEN-02', '권한', '미정'));
  assert.deepEqual(codes(open, { status: 'completed' }), ['OPEN_FACT_UNRESOLVED']);
  assert.deepEqual(codes(open, { status: 'action_required', questions: 2 }), ['RECOMMENDED_SCENARIO_MISSING']);
  assert.deepEqual(codes(`${open}\n- 추천 조합 시나리오: 추천 선택지를 모두 같은 상황에 적용해도 모순이 없다.\n`, { status: 'action_required', questions: 2 }), []);
  assert.deepEqual(codes(open, { status: 'action_required', questions: 1 }), []);
  assert.deepEqual(codes(open, { status: 'action_required', questions: 0 }), ['OPEN_FACT_UNRESOLVED']);
});

test('an access unknown filed as an observation is rejected only when the table exists', () => {
  const observation = (text) => `\n| 제안자 | 관찰 | 요청 앵커 | 근거 |\n|---|---|---|---|\n| LENS-SECURITY | ${text} | - | 근거 |\n`;
  const misfiled = observation('대상 사용자를 알 수 없어 권한을 정할 근거가 없다(unknown)');
  assert.deepEqual(codes(doc(access) + misfiled, { status: 'completed' }), ['OPEN_FACT_MISFILED']);
  assert.deepEqual(codes(doc(access) + observation('색상 팔레트는 알 수 없다'), { status: 'completed' }), []);
  assert.deepEqual(codes(base + misfiled, { status: 'completed', legacy: true }), []);
});

test('a resume of an analysis published without the table passes; a new or table-bearing one does not', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planSetId = '20260101-community';
  await mkdir(join(root, 'docs/specs', planSetId), { recursive: true });
  const verdict = (context) => evaluateStakeholderAnalysisGate({ root, input: { skill: 'stakeholder-analysis', scope: request, context: { plan_set_id: planSetId, ...context } }, envelope: { status: 'completed', code: 'OK' } });
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), base);
  assert.equal((await verdict({ previous_result_ref: 'runtime/executions/e1/result.json' })).ok, true, 'legacy resume');
  assert.deepEqual((await verdict({})).errors.map(({ code }) => code), ['OPEN_FACTS_MISSING'], 'a new execution');
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), doc(access));
  assert.equal((await verdict({})).ok, true);
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), doc(access, row('OPEN-02', '권한', '미정')));
  assert.deepEqual((await verdict({ previous_result_ref: 'runtime/executions/e1/result.json' })).errors.map(({ code }) => code), ['OPEN_FACT_UNRESOLVED']);
});

const requirements = (cite = '') => `# 요구사항\n\n## 2. 업무\n\n### BIZ-01 글쓰기 (SD-01)\n\n- 업무 규칙:\n  - INV-01 로그인 없이 쓴다 ${cite}\n- 예외 시나리오:\n  - EX-01 글을 불러오지 못하면 오류를 안내한다\n- 완료 조건:\n  - AC-01 글이 보인다\n\n## 6. 공통\n\n### 6.5 업무 결정 점검\n\n| BIZ | 축 | 대상 | 판정 | 근거 |\n|---|---|---|---|---|\n| BIZ-01 | 입력·출처 | 글 목록 | 확정 | INV-01 |\n| BIZ-01 | 결과 | 전체 | 확정 | AC-01 |\n| BIZ-01 | 대상 판정 | 전체 | 해당 없음 | 모든 글을 같은 방식으로 다루고 고르는 규칙이 없다 |\n| BIZ-01 | 대상 없음 | 전체 | 해당 없음 | 글이 없으면 보여 줄 것이 없어 아무 일도 하지 않는다 |\n| BIZ-01 | 실패 | 글 목록 | 확정 | EX-01 |\n| BIZ-01 | 중복·재실행 | 전체 | 해당 없음 | 같은 글을 다시 올려도 별도 글로 취급하는 업무다 |\n| BIZ-01 | 권한·공개 | 전체 | 확정 | INV-01 |\n| BIZ-01 | 보존·되돌림 | 전체 | 해당 없음 | 글을 되돌리거나 보관하는 동작을 이 업무가 다루지 않는다 |\n\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n`;

test('requirements-fix and bounded-context cannot complete while an open fact is 미정 or not reflected', async (t) => {
  const run = (analysis, req = requirements('OPEN-01'), stage = 'requirements-fix') => checkRequirementsDocument({ requirements: req, stage, complete: true, analysis });
  assert.equal(run(doc(access)).ok, true);
  const unresolved = run(doc(access, row('OPEN-02', '권한', '미정')), requirements('OPEN-01'), 'bounded-context');
  assert.deepEqual(unresolved.errors.map(({ code, owner_stage }) => [code, owner_stage]), [['OPEN_FACT_UNRESOLVED', 'requirements-fix']]);
  assert.match(unresolved.errors[0].message, /USER_DECISION_REQUIRED/);
  assert.deepEqual(run(doc(access), requirements()).errors.map(({ code }) => code), ['OPEN_FACT_NOT_REFLECTED']);
  assert.equal(run(base).ok, true, 'no table, no check');
  assert.equal(checkRequirementsDocument({ requirements: requirements(), stage: 'requirements-fix', complete: false, analysis: doc(access) }).ok, true, 'only completion checks');

  const root = await mkdtemp(join(tmpdir(), 'open-facts-req-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planSetId = '20260101-community';
  await mkdir(join(root, 'docs/specs', planSetId), { recursive: true });
  await writeFile(join(root, 'docs/specs', planSetId, 'requirements.md'), requirements('OPEN-01'));
  await writeFile(join(root, 'docs/specs', planSetId, 'stakeholder-analysis.md'), doc(access, row('OPEN-02', '권한', '미정')));
  const verdict = await evaluateRequirementsDocumentGate({ root, input: { skill: 'requirements-fix', context: { plan_set_id: planSetId } }, envelope: { status: 'completed', code: 'OK' } });
  assert.deepEqual(verdict.errors.map(({ code }) => code), ['OPEN_FACT_UNRESOLVED']);
});

test('the approval request tells the orchestrator to confirm a conditional reply', () => {
  const next = finishNext({ status: 'completed', code: 'OK', stageId: 'bounded-context', executionId: 'e1', requirementsPresent: true });
  assert.match(next, /carries a condition or leaves a stated undecided item open, confirm it with the user before sending it as approval/);
  assert.match(next, /Ask whether to approve before tactical design\./);
});

test('stakeholder-analysis completes only when requirements.md cites each 확정 이용 조건 OPEN id', async (t) => {
  assert.deepEqual(codes(doc(access), { status: 'completed', requirements: requirements() }), ['OPEN_FACT_NOT_REFLECTED']);
  assert.deepEqual(codes(doc(access), { status: 'completed', requirements: requirements('— 출처: CAND-02 채택, OPEN-01, answers.json q1') }), []);
  assert.deepEqual(codes(doc(access), { status: 'action_required', questions: 1, requirements: requirements() }), [], 'only a completed stage is checked');
  assert.deepEqual(codes(doc(access, row('OPEN-02', '권한', '확정', 'answers.json')), { status: 'completed', requirements: requirements('OPEN-01') }), [], 'only the 이용 조건 row is required');
  assert.deepEqual(codes(doc(access), { status: 'completed', requirements: requirements(), legacyReflection: true }), []);
  const message = checkStakeholderAnalysis({ request, analysis: doc(access), status: 'completed', requirements: requirements() }).errors[0].message;
  assert.match(message, /OPEN-01.*출처: CAND-02 채택, OPEN-01/);

  const root = await mkdtemp(join(tmpdir(), 'open-reflect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planSetId = '20260101-community';
  const dir = join(root, 'docs/specs', planSetId);
  await mkdir(dir, { recursive: true });
  const verdict = (context) => evaluateStakeholderAnalysisGate({ root, input: { skill: 'stakeholder-analysis', scope: request, context: { plan_set_id: planSetId, ...context } }, envelope: { status: 'completed', code: 'OK' } });
  const resume = { previous_result_ref: 'runtime/executions/e1/result.json' };
  await writeFile(join(dir, 'stakeholder-analysis.md'), doc(access));
  await writeFile(join(dir, 'requirements.md'), requirements());
  assert.deepEqual((await verdict({})).errors.map(({ code }) => code), ['OPEN_FACT_NOT_REFLECTED'], 'a new execution');
  assert.equal((await verdict(resume)).ok, true, 'a resume of an analysis published without the citation');
  await writeFile(join(dir, 'requirements.md'), requirements('OPEN-01'));
  assert.equal((await verdict({})).ok, true);
});
