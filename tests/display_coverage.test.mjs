import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequirementsDocument } from '../.harness/src/workflow/requirements-document-gate.mjs';

const ITEMS = ['데이터 출처', '표시 항목', '누락·부분 데이터', '빈 상태', '불러오기 실패'];
const REASON = '이 업무는 사용자에게 아무 데이터도 보이지 않는 내부 처리다';
// One BIZ whose scenario shows data (핀 목록), with exceptions and acceptance entries.
const biz = (id, { shows = true, ex = '  - EX-01 위치 정보가 없는 항목은 목록에 표시하지 않는다 — 출처: answers.json `e:1`' } = {}) => `### ${id} 장소 보기 (SD-01)

- 상태: draft
- 정상 시나리오:
  1. SC-01 방문자가 ${shows ? '지도에서 핀 목록을 본다' : '내부 점검을 시작한다'}
- 업무 규칙:
  - INV-01 장소는 준비된 고정 데이터에서 온다 — 출처: answers.json \`e:2\`
- 예외 시나리오:
${ex}
- 완료 조건:
  - AC-01 [SC-01] 준비된 장소가 핀으로 보인다
`;
const table = (...rows) => `\n### 6.5 조회·표시 점검\n\n| BIZ | 항목 | 판정 | 근거 |\n|---|---|---|---|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
const full = (id = 'BIZ-01', overrides = {}) => ITEMS.map((item) => [id, item, ...(overrides[item] ?? (item === '누락·부분 데이터' || item === '불러오기 실패' ? ['확정', 'EX-01'] : item === '빈 상태' ? ['해당 없음', '고정 데이터라 목록이 비는 경우가 없다 업무'] : ['확정', 'INV-01, AC-01']))]);
const GAP_NONE = '\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n';
const document = (bizText, rows, gap = GAP_NONE) => `# 요구사항\n\n## 2. 업무\n\n${bizText}\n## 6. 공통\n\n### 6.1 범위·비목표\n\n- 포함: 지도\n${rows === null ? '' : table(...rows)}${gap}`;
const check = (text, stage = 'requirements-fix', analysis = null) => checkRequirementsDocument({ requirements: text, stage, complete: true, analysis });
const codes = (result) => result.errors.map(({ code }) => code);

test('requirements-fix completes with a 6.5 table that settles the five items of every BIZ', () => {
  assert.deepEqual(codes(check(document(biz('BIZ-01'), full()))), []);
  assert.deepEqual(codes(check(document(biz('BIZ-01'), null))), ['DISPLAY_COVERAGE_INCOMPLETE'], 'the table is required');
  const missingRow = check(document(biz('BIZ-01'), full().filter((row) => row[1] !== '빈 상태')));
  assert.deepEqual(codes(missingRow), ['DISPLAY_COVERAGE_INCOMPLETE']);
  assert.equal(missingRow.errors[0].owner_stage, 'requirements-fix');
  assert.equal(codes(check(document(biz('BIZ-01') + '\n' + biz('BIZ-02').replace('INV-01', 'INV-02').replace('EX-01', 'EX-02').replace('AC-01', 'AC-02').replace('SC-01', 'SC-02'), full()))).length, 5, 'every BIZ needs its five rows');
});

test('확정 cites ids defined in that BIZ; the exception items cite an EX', () => {
  const bad = (item, ...value) => codes(check(document(biz('BIZ-01'), full('BIZ-01', { [item]: value }))));
  assert.deepEqual(bad('데이터 출처', '확정', '요청 원문'), ['DISPLAY_COVERAGE_INCOMPLETE'], 'no id');
  assert.deepEqual(bad('데이터 출처', '확정', 'INV-09'), ['DISPLAY_COVERAGE_INCOMPLETE'], 'an id of nowhere');
  assert.deepEqual(bad('불러오기 실패', '확정', 'INV-01'), ['DISPLAY_COVERAGE_INCOMPLETE'], 'needs an EX');
  assert.deepEqual(bad('누락·부분 데이터', '확정', 'AC-01'), ['DISPLAY_COVERAGE_INCOMPLETE'], 'needs an EX');
  assert.deepEqual(bad('표시 항목', '확정', 'SC-01'), [], 'a scenario id counts');
  assert.deepEqual(bad('표시 항목', '생략', 'INV-01'), ['DISPLAY_COVERAGE_INCOMPLETE'], 'the judgment is 확정 or 해당 없음');
});

test('해당 없음 needs a business reason, and a BIZ that shows data cannot skip its source, items or load failure', () => {
  const skipped = (item, reason, bizText = biz('BIZ-01')) => codes(check(document(bizText, full('BIZ-01', { [item]: ['해당 없음', reason] }))));
  assert.deepEqual(skipped('빈 상태', '요청에 없음'), ['DISPLAY_COVERAGE_INCOMPLETE']);
  assert.deepEqual(skipped('빈 상태', '후속 단계에서 정한다 나중에 다시'), ['DISPLAY_COVERAGE_INCOMPLETE']);
  assert.deepEqual(skipped('빈 상태', '미정이라서 아직 정하지 않았다 지금'), ['DISPLAY_COVERAGE_INCOMPLETE']);
  assert.deepEqual(skipped('빈 상태', '고정 장소 세 개가 항상 있어 목록이 비지 않는다'), []);
  for (const item of ['데이터 출처', '표시 항목', '불러오기 실패']) assert.deepEqual(skipped(item, REASON), ['DISPLAY_COVERAGE_INCOMPLETE'], `${item} cannot be skipped for a BIZ that shows data`);
  const internal = biz('BIZ-01', { shows: false }).replace('준비된 장소가 핀으로 보인다', '점검 기록이 남는다').replace('준비된 고정 데이터에서 온다', '점검 기록을 남긴다');
  for (const item of ['데이터 출처', '표시 항목', '불러오기 실패']) assert.deepEqual(skipped(item, REASON, internal), [], `${item} may be skipped for a BIZ that shows nothing`);
});

test('bounded-context checks the table only when it exists; skipped and legacy documents are exempt', () => {
  assert.deepEqual(codes(check(document(biz('BIZ-01'), null), 'bounded-context')), []);
  assert.deepEqual(codes(check(document(biz('BIZ-01'), full().slice(1)), 'bounded-context')), ['DISPLAY_COVERAGE_INCOMPLETE']);
  assert.deepEqual(codes(check(document(biz('BIZ-01'), full()), 'bounded-context')), []);
  assert.deepEqual(codes(check(document(biz('BIZ-01'), null), 'requirements-fix', '# 분석\n\n- 판정: 생략\n')), [], 'a skipped analysis');
  assert.deepEqual(codes(check(document(biz('BIZ-01'), null).replace('## 2. 업무', '## 2. 이벤트 흐름'))), [], 'a document of the legacy numbered format');
  assert.deepEqual(codes(checkRequirementsDocument({ requirements: document(biz('BIZ-01'), null), stage: 'requirements-fix', complete: false })), [], 'only completion checks');
});

test('an exception that is NOT_APPLICABLE or only says the action is not offered is rejected at requirements-fix completion', () => {
  const withEx = (ex, stage = 'requirements-fix') => codes(check(document(biz('BIZ-01', { ex }), full()), stage));
  assert.deepEqual(withEx('  - EX-01 그런 동작은 제공되지 않으며 — 출처: 요청 해석(에이전트 제안)'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 NOT_APPLICABLE — 조건: 없음; 결과: 없음; 별도 실패·거절 경로가 없는 이유: 고정 데이터'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 수정 기능이 없다'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 삭제를 요청하면 제공하지 않는다고 안내한다'), [], 'an observable result makes it a real exception');
  assert.deepEqual(withEx('  - EX-01 위치가 없는 항목은 목록에 표시하지 않는다'), []);
  assert.deepEqual(withEx('  - EX-01 요청이 들어오면 거절된다'), []);
  const noException = biz('BIZ-01').replace(/- 예외 시나리오:\n.*\n/, '- 예외 시나리오: 없음 — 고정 데이터만 보여 주므로 실패 경로가 없다\n');
  assert.ok(!codes(check(document(noException, full()))).includes('EXCEPTION_NOT_FAILURE'), 'the explicit 없음 form stays accepted');
  assert.deepEqual(withEx('  - EX-01 그런 동작은 제공되지 않는다', 'bounded-context'), [], 'enforced at requirements-fix only');
});
