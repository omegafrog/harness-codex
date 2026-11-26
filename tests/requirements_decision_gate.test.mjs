import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerWorkflow } from './support/consumer-workflow.mjs';
import { checkRequirementsDocument, recheckRequirementsBeforeApproval } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { PRE_SPEC_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { KINDS, doc, gapTable, rows } from './support/decision-fixtures.mjs';

const check = (text, extra = {}) => checkRequirementsDocument({ requirements: text, stage: 'requirements-fix', complete: true, analysis: null, ...extra });
const codes = (text) => check(text).errors.map(({ code }) => code);

for (const kind of Object.keys(KINDS)) {
  test(`${kind}: the 6.5 decision table passes when complete and each broken rule is refused`, () => {
    const target = KINDS[kind].target;
    const withRows = (over, extra) => codes(doc(kind, { list: rows(kind, { over, extra }) }));
    const bad = ['DECISION_COVERAGE_INCOMPLETE'];
    assert.deepEqual(codes(doc(kind)), [], 'complete table');
    assert.deepEqual(codes(doc(kind, { list: rows(kind).filter((row) => row[1] !== '권한·공개') })), bad, 'missing axis');
    assert.deepEqual(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '해당 없음', '입력이 필요 없는 처리다']] }), bad, '입력·출처 해당 없음');
    assert.deepEqual(withRows({ '결과': [['BIZ-01', '결과', '전체', '해당 없음', '결과를 남기지 않는 처리다']] }), bad, '결과 해당 없음');
    assert.deepEqual(withRows({ '입력·출처': [['BIZ-01', '입력·출처', target, '기본값', 'INV-03']] }), bad, '입력·출처 기본값');
    assert.deepEqual(withRows({ '권한·공개': [['BIZ-01', '권한·공개', '전체', '기본값', 'INV-03']] }), bad, '권한·공개 기본값');
    assert.deepEqual(withRows({ '실패': [['BIZ-01', '실패', target, '확정', 'INV-01']] }), bad, '실패 확정 without EX');
    assert.deepEqual(withRows({}, [['BIZ-01', '입력·출처', '다른 입력', '확정', 'INV-01']]), bad, '입력·출처 and 실패 targets differ');
    assert.deepEqual(withRows({ '대상 없음': [['BIZ-01', '대상 없음', '전체', '해당 없음', '요청에 없음']] }), bad, 'vague 해당 없음 reason');
    assert.deepEqual(codes(doc(kind, { gaps: gapTable(['GAP-01', 'BIZ-01', 'high', '정렬 기준', '기본값', 'INV-03']) })), ['GAP_REVIEW_INCOMPLETE'], '6.6 기본값 with 영향 high');
    assert.deepEqual(codes(doc(kind, { gaps: gapTable(['GAP-01', 'BIZ-01', 'low', '정렬 기준', '기본값', 'INV-03']) })), [], '6.6 기본값 with 영향 low');
  });
}

const DONE = (id) => ({ status: 'completed', code: 'OK', execution_id: `${id}-1`, result_ref: `runtime/executions/${id}-1/result.json`, finished_at: '2026-01-01T00:00:00.000Z' });
async function waiting(t, text) {
  const flow = await consumerWorkflow(t, '주문 내역 조회 기능을 구현한다');
  const { workspace, planSetId } = flow;
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const id of PRE_SPEC_STAGES.slice(0, PRE_SPEC_STAGES.indexOf('bounded-context') + 1)) {
    state.stages[id] = DONE(id);
    await mkdir(join(workspace, `.io/runtime/executions/${id}-1`), { recursive: true });
    await writeFile(join(workspace, `.io/runtime/executions/${id}-1/result.json`), JSON.stringify({ status: 'completed', code: 'OK', summary: id }));
  }
  state.current_stage = 'bounded-context';
  state.stages['workflow-compose'].plan_set_id = planSetId;
  await writeFile(statePath, JSON.stringify(state));
  await mkdir(join(workspace, `docs/specs/${planSetId}`), { recursive: true });
  await writeFile(join(workspace, `docs/specs/${planSetId}/requirements.md`), text);
  return { workspace, state };
}

test('legacy compat: a complete older 6.5 (with 자료) plus 6.6 passes the approval recheck, a document without 6.5/6.6 is reopened', async (t) => {
  const legacy65 = '\n### 6.5 조회·표시 점검\n\n| BIZ | 자료 | 항목 | 판정 | 근거 |\n|---|---|---|---|---|\n'
    + [['BIZ-01', '주문 기록', '데이터 출처', '확정', 'INV-01'], ['BIZ-01', '전체', '표시 항목', '확정', 'AC-01'], ['BIZ-01', '전체', '누락·부분 데이터', '확정', 'EX-01'],
      ['BIZ-01', '전체', '빈 상태', '해당 없음', '주문이 없으면 목록 자체를 보이지 않는다'], ['BIZ-01', '주문 기록', '불러오기 실패', '확정', 'EX-01']].map((row) => `| ${row.join(' | ')} |`).join('\n') + '\n';
  const legacy66 = '\n### 6.6 빈틈 검토\n\n| GAP | BIZ | 추측해야 하는 것 | 처리 | 근거 |\n|---|---|---|---|---|\n| GAP-01 | BIZ-01 | 취소 주문의 위치 | 확정 | INV-03 |\n';
  const ok = await waiting(t, doc('lookup', { display: legacy65, gaps: legacy66 }));
  assert.deepEqual(recheckRequirementsBeforeApproval({ root: ok.workspace, state: ok.state }), { applies: true, ok: true });
  const none = await waiting(t, doc('lookup', { display: '', gaps: '' }));
  const verdict = recheckRequirementsBeforeApproval({ root: none.workspace, state: none.state });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reopen_args, ['--stage-id', 'requirements-fix', '--reopen-for', 'bounded-context-1']);
});
