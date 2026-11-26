import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequirementsDocument } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { AGENT, AXES, KINDS, NONE_66, biz, doc, gapTable, rows, table65 } from './support/decision-fixtures.mjs';

const check = (text, stage = 'requirements-fix', analysis = null, extra = {}) => checkRequirementsDocument({ requirements: text, stage, complete: true, analysis, ...extra });
const codes = (verdict) => verdict.errors.map(({ code }) => code);
const messages = (verdict) => verdict.errors.map(({ message }) => message).join('\n');

for (const kind of Object.keys(KINDS)) {
  test(`${kind}: a 6.5 that walks every axis passes and each broken rule is refused`, () => {
    assert.deepEqual(codes(check(doc(kind))), [], 'positive');
    const withRows = (over, extra) => check(doc(kind, { list: rows(kind, { over, extra }) }));
    const target = KINDS[kind].target;
    // A missing axis, a wrong shape and an unknown axis.
    assert.deepEqual(codes(check(doc(kind, { list: rows(kind).filter((row) => row[1] !== '중복·재실행') }))), ['DECISION_COVERAGE_INCOMPLETE'], 'every axis needs a row');
    assert.deepEqual(codes(withRows({}, [['BIZ-01', '결과', '전체', '확정', 'AC-01']])), ['DECISION_COVERAGE_INCOMPLETE'], 'one row for the whole-BIZ axes');
    assert.deepEqual(codes(withRows({ '결과': [['BIZ-01', '결과', target, '확정', 'AC-01']] })), ['DECISION_COVERAGE_INCOMPLETE'], '대상 is 전체 for the whole-BIZ axes');
    assert.deepEqual(codes(withRows({}, [['BIZ-01', '표시', '전체', '확정', 'AC-01']])), ['DECISION_COVERAGE_INCOMPLETE'], 'only the eight axes');
    assert.deepEqual(codes(check(doc(kind, { list: rows(kind, { id: 'BIZ-09' }) }))).includes('DECISION_COVERAGE_INCOMPLETE'), true, 'rows of a BIZ the document lacks');
    // 입력·출처 and 실패 cover the same 대상 set, once each.
    assert.deepEqual(codes(withRows({}, [['BIZ-01', '입력·출처', '다른 입력', '확정', 'INV-01']])), ['DECISION_COVERAGE_INCOMPLETE'], 'an input judged for one axis only');
    assert.deepEqual(codes(withRows({}, [['BIZ-01', '입력·출처', '다른 입력', '확정', 'INV-01'], ['BIZ-01', '실패', '다른 입력', '확정', 'EX-01']])), [], 'two inputs, both axes');
    assert.deepEqual(codes(withRows({}, [['BIZ-01', '실패', target, '확정', 'EX-01']])), ['DECISION_COVERAGE_INCOMPLETE'], 'an input appears once per axis');
    // Judgments.
    assert.deepEqual(codes(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '확정', 'INV-09']] })), ['DECISION_COVERAGE_INCOMPLETE'], 'an id of nowhere');
    assert.deepEqual(codes(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '확정', '요청 원문']] })), ['DECISION_COVERAGE_INCOMPLETE'], 'no id');
    assert.deepEqual(codes(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '해당 없음', '이 업무는 입력이 필요 없는 처리다']] })), ['DECISION_COVERAGE_INCOMPLETE'], '입력·출처 is never 해당 없음');
    assert.deepEqual(codes(withRows({ '결과': [['BIZ-01', '결과', '전체', '해당 없음', '이 업무는 결과를 남기지 않는 처리다']] })), ['DECISION_COVERAGE_INCOMPLETE'], '결과 is never 해당 없음');
    assert.deepEqual(codes(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '기본값', 'INV-03']] })), ['DECISION_COVERAGE_INCOMPLETE'], '입력·출처 is never a 기본값');
    assert.deepEqual(codes(withRows({ '권한·공개': [['BIZ-01', '권한·공개', '전체', '기본값', 'INV-03']] })), ['DECISION_COVERAGE_INCOMPLETE'], '권한·공개 is never a 기본값');
    assert.deepEqual(codes(withRows({ '중복·재실행': [['BIZ-01', '중복·재실행', '전체', '기본값', 'INV-01']] })), ['DECISION_COVERAGE_INCOMPLETE'], 'a 기본값 cites an id sourced as the agent\'s interpretation');
    assert.deepEqual(codes(withRows({ '중복·재실행': [['BIZ-01', '중복·재실행', '전체', '기본값', 'INV-03']] })), [], 'a 기본값 of an agent-sourced id');
    assert.deepEqual(codes(withRows({ '실패': [['BIZ-01', '실패', target, '확정', 'INV-01']] })), ['DECISION_COVERAGE_INCOMPLETE'], '실패 cites an EX');
    assert.deepEqual(codes(withRows({ '실패': [['BIZ-01', '실패', target, '해당 없음', '입력이 없어 실패할 일이 없는 처리다']] })), [], '실패 may be 해당 없음 with a reason');
    assert.deepEqual(codes(withRows({ '대상 없음': [['BIZ-01', '대상 없음', '전체', '해당 없음', '요청에 없음']] })), ['DECISION_COVERAGE_INCOMPLETE'], '"요청에 없음" is no reason');
    assert.deepEqual(codes(withRows({ '대상 없음': [['BIZ-01', '대상 없음', '전체', '해당 없음', '후속 단계에서 정한다 나중에 다시']] })), ['DECISION_COVERAGE_INCOMPLETE'], 'a deferral is no reason');
    assert.match(messages(withRows({ '대상 없음': [['BIZ-01', '대상 없음', '전체', '미정', '']] })), /미정 is provisional/, '미정 only before completion');
    assert.match(messages(withRows({ '대상 없음': [['BIZ-01', '대상 없음', '전체', '임시', '']] })), /must be 확정, 기본값 or 해당 없음/);
  });
}

test('display words decide nothing: a BIZ that mentions lists and screens has the same eight axes as any other', () => {
  // The old rule forced three items for BIZ text with display words; the axes are the same for every kind of work now.
  assert.deepEqual(codes(check(doc('lookup'))), []);
  assert.deepEqual(codes(check(doc('settlement', { list: rows('settlement', { over: { '대상 없음': [['BIZ-01', '대상 없음', '전체', '해당 없음', '이번 달에 거래가 없으면 빈 정산서를 만들지 않는다']] } }) }))), []);
});

test('the older 6.5 with a 자료 column is not reopened by the format change, the missing or oldest shape is', () => {
  const legacyTable = (list) => `\n### 6.5 조회·표시 점검\n\n| BIZ | 자료 | 항목 | 판정 | 근거 |\n|---|---|---|---|---|\n${list.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
  const legacyRows = [['BIZ-01', '주문 기록', '데이터 출처', '확정', 'INV-01'], ['BIZ-01', '전체', '표시 항목', '확정', 'AC-01'], ['BIZ-01', '전체', '누락·부분 데이터', '확정', 'EX-01'], ['BIZ-01', '전체', '빈 상태', '해당 없음', '주문이 없으면 목록 자체를 보이지 않는다'], ['BIZ-01', '주문 기록', '불러오기 실패', '확정', 'EX-01']];
  const legacyGaps = '\n### 6.6 빈틈 검토\n\n| GAP | BIZ | 추측해야 하는 것 | 처리 | 근거 |\n|---|---|---|---|---|\n| GAP-01 | BIZ-01 | 취소 주문의 위치 | 확정 | INV-03 |\n';
  const legacy = doc('lookup', { display: legacyTable(legacyRows), gaps: legacyGaps });
  // At a new requirements-fix completion the new shapes are required ...
  assert.match(messages(check(legacy)), /older shape|업무 결정 점검/);
  assert.ok(codes(check(legacy)).includes('GAP_REVIEW_INCOMPLETE'), 'the 6.6 table needs the 영향 column');
  // ... the approval recheck (allowLegacy) accepts a complete older document, and bounded-context checks what exists.
  assert.deepEqual(codes(check(legacy, 'requirements-fix', null, { allowLegacy: true })), []);
  assert.deepEqual(codes(check(legacy, 'bounded-context')), []);
  // An older table that is itself incomplete still fails in the recheck.
  assert.deepEqual(codes(check(doc('lookup', { display: legacyTable(legacyRows.slice(1)), gaps: legacyGaps }), 'requirements-fix', null, { allowLegacy: true })), ['DECISION_COVERAGE_INCOMPLETE']);
  // No 6.5 at all, or the oldest shape (no 자료 column), still reopens; bounded-context stays exempt.
  assert.deepEqual(codes(check(doc('lookup', { display: '', gaps: legacyGaps }), 'requirements-fix', null, { allowLegacy: true })), ['DECISION_COVERAGE_INCOMPLETE']);
  const oldest = doc('lookup', { display: `\n### 6.5 조회·표시 점검\n\n| BIZ | 항목 | 판정 | 근거 |\n|---|---|---|---|\n| BIZ-01 | 데이터 출처 | 확정 | INV-01 |\n`, gaps: NONE_66 });
  assert.deepEqual(codes(check(oldest, 'requirements-fix', null, { allowLegacy: true })), ['DECISION_COVERAGE_INCOMPLETE']);
  assert.deepEqual(codes(check(oldest, 'bounded-context')), []);
  assert.deepEqual(codes(check(doc('lookup', { display: '' }), 'bounded-context')), [], 'absent at bounded-context');
});

test('6.6 carries the reviewer\'s impact and a 기본값 only for a low one', () => {
  const gap = (...cells) => check(doc('lookup', { gaps: gapTable(cells) }));
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-01', 'high', '취소 뒤 환불 여부', '확정', 'INV-02')), []);
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-01', 'low', '목록의 정렬', '기본값', 'INV-03')), []);
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-01', 'high', '취소 뒤 환불 여부', '기본값', 'INV-03')), ['GAP_REVIEW_INCOMPLETE'], 'a high gap is no default');
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-01', 'low', '목록의 정렬', '기본값', 'INV-02')), ['GAP_REVIEW_INCOMPLETE'], 'a default cites an agent-sourced id');
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-01', 'mid', '목록의 정렬', '확정', 'INV-02')), ['GAP_REVIEW_INCOMPLETE'], '영향 is high or low');
  assert.deepEqual(codes(gap('GAP-01', 'BIZ-09', 'low', '목록의 정렬', '확정', 'INV-02')), ['GAP_REVIEW_INCOMPLETE']);
  assert.deepEqual(codes(check(doc('lookup', { gaps: '' }))), ['GAP_REVIEW_INCOMPLETE'], 'the section is required');
  assert.deepEqual(codes(check(doc('lookup', { gaps: gapTable(['GAP-01', 'BIZ-01', 'low', '목록의 정렬', '기본값', 'INV-03']) }), 'bounded-context')), []);
});

test('exemptions: a skipped analysis, an unnumbered document and a non-completing check', () => {
  assert.deepEqual(codes(check(doc('lookup', { display: '', gaps: '' }), 'requirements-fix', '# 분석\n\n- 판정: 생략\n')), []);
  assert.deepEqual(codes(check(doc('lookup', { display: '', gaps: '' }).replace('## 2. 업무', '## 2. 이벤트 흐름'))), []);
  assert.deepEqual(codes(checkRequirementsDocument({ requirements: doc('lookup', { display: '', gaps: '' }), stage: 'requirements-fix', complete: false })), []);
});

test('an exception that is NOT_APPLICABLE or only says the action is not offered is rejected at requirements-fix completion', () => {
  const withEx = (ex, stage = 'requirements-fix') => codes(check(doc('lookup', { bizText: biz('lookup').replace(/  - EX-01 .*/, ex) }), stage));
  assert.deepEqual(withEx('  - EX-01 그런 동작은 제공되지 않으며 — 출처: 요청 해석(에이전트 제안)'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 NOT_APPLICABLE — 조건: 없음; 결과: 없음'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 수정 기능이 없다'), ['EXCEPTION_NOT_FAILURE']);
  assert.deepEqual(withEx('  - EX-01 삭제를 요청하면 제공하지 않는다고 안내한다'), [], 'an observable result makes it a real exception');
  assert.deepEqual(withEx('  - EX-01 요청이 들어오면 거절된다'), []);
  assert.deepEqual(withEx('  - EX-01 그런 동작은 제공되지 않는다', 'bounded-context'), [], 'enforced at requirements-fix only');
  assert.ok(AGENT && AXES.length === 8 && table65([]).includes('업무 결정 점검') && NONE_66);
});
