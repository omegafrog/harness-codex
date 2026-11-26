// Requirements documents of three unrelated kinds of work (a lookup screen, a notification on expiry, a monthly settlement), each with the
// same id layout so one set of rows can be varied for positive and negative cases of the 6.5 / 6.6 gate.
export const AXES = ['입력·출처', '결과', '대상 판정', '대상 없음', '실패', '중복·재실행', '권한·공개', '보존·되돌림'];
export const NONE_66 = '\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n';
export const LIVE_SOURCE = (n) => `— 출처: answers.json \`q:${n}\``;
export const AGENT = '— 출처: 요청 해석(에이전트 제안)';

export const KINDS = {
  lookup: {
    title: '주문 내역 조회', target: '주문 기록',
    scenario: '회원이 자기 주문 내역 목록을 본다', input: '내역은 주문 시스템이 기록한 주문에서 온다', permission: '본인 주문만 보인다',
    pick: '취소된 주문은 목록 끝에 둔다', again: '같은 조회를 다시 해도 같은 내역이 나온다', failure: '내역을 불러오지 못하면 불러오지 못했다는 안내를 보인다', result: '본인 주문 내역이 최신순으로 보인다',
  },
  expiry: {
    title: '승인 만료 알림', target: '승인 기록',
    scenario: '승인 기한이 지나면 요청자에게 알림이 간다', input: '만료 시각은 승인 기록에 적힌 기한에서 온다', permission: '알림은 요청자에게만 간다',
    pick: '이미 취소한 승인에는 알림을 보내지 않는다', again: '같은 승인에 알림은 한 번만 간다', failure: '승인 기록을 읽지 못하면 알림을 보내지 않고 운영자에게 알린다', result: '요청자가 만료 알림을 받는다',
  },
  settlement: {
    title: '월별 정산', target: '원장',
    scenario: '월말에 팀별 합계 정산서를 만든다', input: '금액은 원장에 기록된 거래에서 온다', permission: '정산서는 재무 담당자에게만 보인다',
    pick: '환불된 거래는 합계에서 뺀다', again: '같은 달을 다시 정산하면 이전 정산서를 대체한다', failure: '원장을 읽지 못하면 그 달을 마감하지 않고 담당자에게 알린다', result: '재무 담당자가 팀별 합계 정산서를 받는다',
  },
};

// The BIZ section with every id the default rows cite: INV-01 input, INV-02 permission, INV-03 an unasked default, INV-04 repeat, EX-01 failure, AC-01 result.
export const biz = (kind, id = 'BIZ-01', { extra = '', pickSource = AGENT } = {}) => {
  const k = KINDS[kind];
  return `### ${id} ${k.title} (SD-01)

- 상태: draft
- 정상 시나리오:
  1. SC-01 ${k.scenario}
- 업무 규칙:
  - INV-01 ${k.input} ${LIVE_SOURCE(1)}
  - INV-02 ${k.permission} ${LIVE_SOURCE(2)}
  - INV-03 ${k.pick} ${pickSource}
  - INV-04 ${k.again} ${LIVE_SOURCE(3)}${extra}
- 예외 시나리오:
  - EX-01 ${k.failure} ${LIVE_SOURCE(4)}
- 완료 조건:
  - AC-01 [SC-01] ${k.result}
`;
};

const NA = { '대상 없음': '대상이 하나도 없는 날은 이 업무가 아무것도 하지 않는다', '보존·되돌림': '결과를 되돌리거나 보관하는 동작을 이 업무가 다루지 않는다' };
// One row per axis; `over` replaces rows by axis (an array of rows replaces all of them), `extra` appends rows.
export const rows = (kind, { id = 'BIZ-01', over = {}, extra = [] } = {}) => {
  const target = KINDS[kind].target;
  const base = {
    '입력·출처': [[id, '입력·출처', target, '확정', 'INV-01']],
    '결과': [[id, '결과', '전체', '확정', 'AC-01']],
    '대상 판정': [[id, '대상 판정', '전체', '기본값', 'INV-03']],
    '대상 없음': [[id, '대상 없음', '전체', '해당 없음', NA['대상 없음']]],
    '실패': [[id, '실패', target, '확정', 'EX-01']],
    '중복·재실행': [[id, '중복·재실행', '전체', '확정', 'INV-04']],
    '권한·공개': [[id, '권한·공개', '전체', '확정', 'INV-02']],
    '보존·되돌림': [[id, '보존·되돌림', '전체', '해당 없음', NA['보존·되돌림']]],
  };
  return AXES.flatMap((axis) => over[axis] ?? base[axis]).concat(extra);
};
export const table65 = (list) => `\n### 6.5 업무 결정 점검\n\n| BIZ | 축 | 대상 | 판정 | 근거 |\n|---|---|---|---|---|\n${list.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
export const gapTable = (...list) => `\n### 6.6 빈틈 검토\n\n| GAP | BIZ | 영향 | 추측해야 하는 것 | 처리 | 근거 |\n|---|---|---|---|---|---|\n${list.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
export const doc = (kind, { list = rows(kind), gaps = NONE_66, bizText = biz(kind), display = table65(list) } = {}) => `# 요구사항 명세\n\n## 2. 업무\n\n${bizText}\n## 6. 공통\n\n### 6.1 범위·비목표\n\n- 포함: ${KINDS[kind].title}\n${display}${gaps}`;
// The reviewer's main-mode answer for the default rows of a kind (all answered unless `over` says otherwise).
export const reviewed = (kind, { over = {}, gaps = [], missing = [] } = {}) => ({
  rows: rows(kind).map(([bizId, axis, target]) => ({ biz: bizId, target, axis, answered: true, impact: 'low', why: '문장이 답한다', ...(over[axis] ?? {}) })),
  gaps, missing_inputs: missing,
});
