import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateRequirementsDocumentGate, requirementsDefaults } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { compactFinished } from '../.harness/src/workflow/stage-cli.mjs';

const ITEMS = ['입력·출처', '결과', '대상 판정', '대상 없음', '실패', '중복·재실행', '권한·공개', '보존·되돌림'];
const OPEN = '대상 없음';
const resourceOf = (item) => item === '입력·출처' || item === '실패' ? '목록' : '전체';
const BIZ = `### BIZ-01 월별 정산 (SD-01)

- 상태: draft
- 정상 시나리오:
  1. SC-01 담당자가 월별 정산 목록을 본다
- 업무 규칙:
  - INV-01 정산은 확정된 거래만 센다 — 출처: answers.json \`rf-1:1\`
  - INV-02 마감 뒤에는 수정할 수 없다 — 출처: 요청 해석(에이전트 제안)
- 예외 시나리오:
  - EX-01 거래가 없으면 항목을 표시하지 않는다 — 출처: answers.json \`rf-1:1\`
- 완료 조건:
  - AC-01 [SC-01] 확정된 거래가 보인다
`;
const display = (empty = ['확정', 'INV-01']) => `\n### 6.5 업무 결정 점검\n\n| BIZ | 축 | 대상 | 판정 | 근거 |\n|---|---|---|---|---|\n${ITEMS.map((item) => `| BIZ-01 | ${item} | ${resourceOf(item)} | ${item === OPEN ? empty.join(' | ') : `확정 | ${item === '실패' ? 'EX-01' : 'INV-01'}`} |`).join('\n')}\n`;
const NONE = '\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n';
const doc = (extra = '', empty) => `# 요구사항 명세\n\n## 2. 업무\n\n${BIZ}\n## 6. 공통\n\n### 6.1 범위·비목표\n\n- 포함: 정산\n${display(empty)}${extra || NONE}`;
const ROWS = ITEMS.map((item) => ({ biz: 'BIZ-01', axis: item, target: resourceOf(item), answered: true, why: '답한다' }));
const FUTURE = '2999-01-01T00:00:00.000Z';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'verify-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = 'settle';
  const write = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  const stops = (...results) => write('.io/runtime/executions/rf-1/subagents.jsonl', `${results.map(({ result, at }, index) => JSON.stringify({ event: 'SubagentStop', agent_id: `r${index}`, agent_type: 'requirements_gap_reviewer', result: JSON.stringify(result), ...(at ? { recorded_at: at } : {}) })).join('\n')}\n`);
  const answer = () => write('.io/runtime/executions/rf-1/decision-answers.json', JSON.stringify([{ question_id: 'rf-1:1', answer: '확정된 거래만 센다' }]));
  const gate = async (requirements) => {
    await write(`docs/specs/${plan}/requirements.md`, requirements);
    return evaluateRequirementsDocumentGate({ root, input: { skill: 'requirements-fix', execution_id: 'rf-1', context: { plan_set_id: plan } }, envelope: { status: 'completed', code: 'OK' } });
  };
  return { root, plan, write, stops, answer, gate };
}
const main = { rows: ROWS, gaps: [], missing_inputs: [] };
const messages = (verdict) => verdict.errors.map((error) => error.message).join('\n');

test('verify run is required after the latest answer and its findings must be fixed in the document', async (t) => {
  const { stops, answer, gate } = await setup(t);
  await stops({ result: main });
  assert.equal((await gate(doc())).ok, true, 'no answers: no verify needed');
  await answer();
  const none = await gate(doc());
  assert.equal(none.ok, false);
  assert.match(messages(none), /must verify the result once in mode verify/);
  await stops({ result: main }, { result: { unsupported: [], conflicts: [] }, at: '2000-01-01T00:00:00.000Z' });
  assert.equal((await gate(doc())).ok, false, 'a verify run older than the latest answer does not count');
  await stops({ result: main }, { result: { unsupported: [], conflicts: [] }, at: FUTURE });
  assert.equal((await gate(doc())).ok, true, 'a clean verify run after the answer');
  await stops({ result: main }, { result: 'not json at all', at: FUTURE });
  assert.equal((await gate(doc())).ok, false, 'invalid JSON is no verify run');

  const unsupported = { unsupported: [{ id: 'INV-01', quote: '확정된 거래만 센다', why: '답에 없는 조건' }], conflicts: [] };
  await stops({ result: main }, { result: unsupported, at: FUTURE });
  assert.match(messages(await gate(doc())), /attributed to a user answer that the answer does not say/);
  const fixed = doc().replace('INV-01 정산은 확정된 거래만 센다', 'INV-01 정산은 거래를 센다');
  assert.equal((await gate(fixed)).ok, true, 'the unsupported quote is gone');

  const conflict = { unsupported: [], conflicts: [{ ids: ['INV-01', 'INV-02'], quotes: ['확정된 거래만 센다', '마감 뒤에는 수정할 수 없다'], why: '충돌' }] };
  await stops({ result: main }, { result: conflict, at: FUTURE });
  assert.match(messages(await gate(doc())), /cannot both hold/);
  assert.equal((await gate(doc().replace('INV-02 마감 뒤에는 수정할 수 없다', 'INV-02 마감 뒤에는 관리자만 수정한다'))).ok, true, 'one quote removed');
  await stops({ result: main }, { result: { unsupported: [], conflicts: [{ ids: ['INV-01'], quotes: [], why: '충돌' }] }, at: FUTURE });
  assert.equal((await gate(doc())).ok, false, 'a conflict without quotes cannot be shown fixed');
});

test('old reviewer records without impact count as high; low may become a 기본값', async (t) => {
  const { stops, gate } = await setup(t);
  const open = (impact) => ({ rows: ROWS.map((row) => row.axis === OPEN ? { ...row, answered: false, ...(impact ? { impact } : {}) } : row), gaps: [], missing_inputs: [] });
  const asDefault = doc('', ['기본값', 'INV-02']);
  await stops({ result: open(undefined) });
  assert.equal((await gate(asDefault)).ok, false, 'no impact: high, a 기본값 does not settle it');
  assert.match(messages(await gate(asDefault)), /impact high/);
  await stops({ result: open('high') });
  assert.equal((await gate(asDefault)).ok, false);
  await stops({ result: open('low') });
  assert.equal((await gate(asDefault)).ok, true, 'low impact may be a 기본값');
  await stops({ result: { rows: ROWS, gaps: [{ biz: 'BIZ-01', gap: '마감 뒤 수정', why_it_changes_the_result: '수정 가능 여부', quote: '마감 뒤' }], missing_inputs: [] } });
  assert.match(messages(await gate(doc())), /high impact/, 'a gap without impact needs a high 6.6 row');
});

test('requirementsDefaults lists 기본값 decisions and the completion output carries defaults_ko', async (t) => {
  const { root, plan, write } = await setup(t);
  await write(`docs/specs/${plan}/requirements.md`, doc());
  assert.deepEqual(requirementsDefaults({ root, planSetId: plan }), []);
  assert.deepEqual(requirementsDefaults({ root, planSetId: 'missing' }), []);

  const gap = '\n### 6.6 빈틈 검토\n\n| GAP | BIZ | 추측해야 하는 것 | 처리 | 근거 |\n|---|---|---|---|---|\n| GAP-01 | BIZ-01 | 마감 시각 | 기본값 | INV-02 |\n';
  await write(`docs/specs/${plan}/requirements.md`, doc(gap, ['기본값', 'INV-02']));
  const list = requirementsDefaults({ root, planSetId: plan });
  assert.equal(list.length, 2);
  assert.ok(list.some((line) => line.includes('BIZ-01') && line.includes(OPEN) && line.includes('마감 뒤에는 수정할 수 없다')), list.join('\n'));
  assert.ok(list.some((line) => line.includes('마감 시각') && line.includes('마감 뒤에는 수정할 수 없다')));
  assert.ok(list.every((line) => !line.includes('출처:')), 'the source tail is stripped');

  const envelope = { status: 'completed', code: 'OK', result: {} };
  const out = compactFinished({ envelope, stageId: 'bounded-context', executionId: 'bc-1', requirementsPresent: true, requirementsDefaults: list });
  assert.deepEqual(out.defaults_ko, list);
  assert.match(out.next, /묻지 않고 정한 것/);
  assert.match(out.next, /defaults_ko/);
  const empty = compactFinished({ envelope, stageId: 'bounded-context', executionId: 'bc-1', requirementsPresent: true, requirementsDefaults: [] });
  assert.equal('defaults_ko' in empty, false);
  assert.doesNotMatch(empty.next, /묻지 않고 정한 것/);
});

test('requirementsDefaults drops an agent hotspot whose target rule was later settled by a user answer', async (t) => {
  const { root, plan, write } = await setup(t);
  const hs = (id) => `\n## 5. 핫스팟\n\n| HS | 질문 | 관련 BIZ | 상태 | 결정 | 출처 |\n|---|---|---|---|---|---|\n| HS-01 | 누가 받는가 | BIZ-01 | 해결 | 모두 → ${id} | 요청 해석(에이전트 제안) |\n`;
  await write(`docs/specs/${plan}/requirements.md`, doc(hs('INV-01')));
  assert.deepEqual(requirementsDefaults({ root, planSetId: plan }), [], 'INV-01 cites answers.json');
  await write(`docs/specs/${plan}/requirements.md`, doc(hs('INV-02')));
  assert.equal(requirementsDefaults({ root, planSetId: plan }).length, 1, 'INV-02 is a genuine default');
});
