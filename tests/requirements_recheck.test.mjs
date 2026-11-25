import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerWorkflow } from './support/consumer-workflow.mjs';
import { recheckRequirementsBeforeApproval, checkRequirementsDocument } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { resolveApprovalOrRevision, resolveReplyTarget } from '../.harness/src/workflow/answer-text.mjs';
import { assertRequirementsApproval } from '../.harness/src/workflow/user-inputs.mjs';
import { resolveReopen } from '../.harness/src/workflow/stage-reopen.mjs';
import { PRE_SPEC_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';

const REQUEST = '커뮤니티 로그아웃과 현재 세션 조회 기능을 구현한다';
const ITEMS = ['데이터 출처', '표시 항목', '누락·부분 데이터', '빈 상태', '불러오기 실패'];
const BIZ = `### BIZ-01 장소 보기 (SD-01)

- 상태: fixed
- 정상 시나리오:
  1. SC-01 방문자가 지도에서 핀 목록을 본다
- 업무 규칙:
  - INV-01 장소는 준비된 고정 데이터에서 온다 — 출처: answers.json \`e:2\`
- 예외 시나리오:
  - EX-01 위치 정보가 없는 항목은 목록에 표시하지 않는다 — 출처: answers.json \`e:1\`
- 완료 조건:
  - AC-01 [SC-01] 준비된 장소가 핀으로 보인다
`;
const TABLE_65 = `\n### 6.5 조회·표시 점검\n\n| BIZ | 자료 | 항목 | 판정 | 근거 |\n|---|---|---|---|---|\n${ITEMS.map((item) => `| BIZ-01 | ${item === '데이터 출처' || item === '불러오기 실패' ? '장소 목록' : '전체'} | ${item} | 확정 | ${item === '누락·부분 데이터' || item === '불러오기 실패' ? 'EX-01' : 'INV-01'} |`).join('\n')}\n`;
const NONE_66 = '\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n';
// bounded-context legitimately adds the fixed status and the `### 1.1` context table; neither may fail the requirements-fix rules.
const CONTEXTS = '\n### 1.1 바운디드 컨텍스트\n\n| BC | 이름 | 책임 | 소유 규칙·데이터 | BIZ |\n|---|---|---|---|---|\n| BC-01 | 지도 | 장소 보기 | INV-01 | BIZ-01 |\n';
const document = ({ gaps = NONE_66, display = TABLE_65, biz = BIZ } = {}) => `# 요구사항 명세\n\n- 상태: fixed\n\n## 1. 서브도메인\n${CONTEXTS}\n## 2. 업무\n\n${biz}\n## 6. 공통\n\n### 6.1 범위·비목표\n\n- 포함: 지도\n${display}${gaps}`;
const OLD = document({ gaps: '', display: '' }).replace('EX-01 위치 정보가 없는 항목은 목록에 표시하지 않는다', 'EX-01 그런 동작은 제공되지 않는다');

const DONE = (id) => ({ status: 'completed', code: 'OK', execution_id: `${id}-1`, result_ref: `runtime/executions/${id}-1/result.json`, finished_at: '2026-01-01T00:00:00.000Z' });

// A workflow waiting for the requirements approval: bounded-context completed, domain-model never started.
async function waiting(t, text) {
  const flow = await consumerWorkflow(t, REQUEST);
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
  const write = (body) => mkdir(join(workspace, `docs/specs/${planSetId}`), { recursive: true }).then(() => writeFile(join(workspace, `docs/specs/${planSetId}/requirements.md`), body));
  await write(text);
  return { ...flow, state, statePath, write };
}
const run = (workspace, script, args) => spawnSync(process.execPath, [join(workspace, '.harness/scripts', script), ...args], { cwd: workspace, encoding: 'utf8' });

test('the gate accepts a document that bounded-context altered legitimately and refuses one fixed under older rules', () => {
  const check = (requirements, analysis = null) => checkRequirementsDocument({ requirements, stage: 'requirements-fix', complete: true, analysis }).errors.map(({ code }) => code);
  assert.deepEqual(check(document()), [], 'fixed status and the 1.1 table pass');
  assert.deepEqual([...new Set(check(OLD))].sort(), ['DISPLAY_COVERAGE_INCOMPLETE', 'EXCEPTION_NOT_FAILURE', 'GAP_REVIEW_INCOMPLETE']);
  assert.deepEqual(check(OLD.replace('## 2. 업무', '## 2. 이벤트 흐름')), [], 'an unnumbered document is exempt');
  assert.deepEqual(check(document({ gaps: '', display: '' }), '# 분석\n\n- 판정: 생략\n'), [], 'a skipped analysis is exempt');
});

test('a deficient fixed document: the approval is not recorded and reopens requirements-fix instead', async (t) => {
  const flow = await waiting(t, OLD);
  const { workspace, state } = flow;
  const verdict = recheckRequirementsBeforeApproval({ root: workspace, state });
  assert.equal(verdict.applies, true);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reopen_args, ['--stage-id', 'requirements-fix', '--reopen-for', 'bounded-context-1']);
  assert.match(verdict.notice_ko, /다시 엽니다/);

  // The reply route: an approval becomes the reopen, never domain-model.
  const target = resolveReplyTarget(workspace, '승인합니다');
  assert.deepEqual(target.args, ['--stage-id', 'requirements-fix', '--reopen-for', 'bounded-context-1']);
  assert.equal(target.approval, undefined);
  assert.equal(target.reopen, 'requirements');
  assert.match(target.notice, /요구사항 작성 단계를 먼저 다시 엽니다/);
  const answered = JSON.parse(run(workspace, 'harness-native-stage.mjs', ['answer', '--text', '승인합니다']).stderr || '{}');
  assert.notEqual(answered.code, 'ANSWER_REFUSED');
  // A change request is still a user revision of its owner, untouched by the recheck.
  assert.equal(resolveApprovalOrRevision(state, '신고 규칙 문구를 바꿔 주세요', { root: workspace }).args.includes('--user-revision'), true);

  // The direct route: the approval launch is refused with the reopen command and nothing is recorded.
  const refusal = await assertRequirementsApproval({ root: workspace, state, stage: 'domain-model', planSetId: flow.planSetId, approval: { execution_id: 'bounded-context-1', answer: '승인합니다' } }).catch((error) => error);
  assert.match(refusal.message, /Requirements recheck required before approval: bounded-context bounded-context-1/);
  assert.match(refusal.message, /--reopen-for bounded-context-1/);
  assert.match(refusal.message, /DISPLAY_COVERAGE_INCOMPLETE/);
  assert.equal(refusal.approval_search, undefined, 'the reply search never ran: nothing about the approval was recorded');
  const after = JSON.parse(await readFile(flow.statePath, 'utf8'));
  assert.equal(after.stages['domain-model'], undefined, 'domain-model did not start');

  // The resume path offers the same reopen command, not an approval question.
  const context = JSON.parse(run(workspace, 'harness-context.mjs', []).stdout);
  assert.match(context.next, /--stage-id requirements-fix --reopen-for bounded-context-1/);
  assert.match(context.next, /one sentence/);
  assert.doesNotMatch(context.next, /Ask whether to approve/);
  assert.doesNotMatch(context.next, /--user-revision true/);
});

test('the reopen uses the dependency mechanism: gate errors verbatim as the reason, bounded-context marked for revalidation', async (t) => {
  const { workspace, state } = await waiting(t, OLD);
  const plan = await resolveReopen({ root: workspace, session: join(workspace, '.io'), state, ownerStage: 'requirements-fix', blockedExecutionId: 'bounded-context-1' });
  assert.equal(plan.owner_stage, 'requirements-fix');
  assert.equal(plan.blocked_stage, 'bounded-context');
  assert.deepEqual(plan.mark, ['bounded-context']);
  assert.deepEqual(plan.stale.rerun_order, ['requirements-fix', 'bounded-context']);
  assert.equal(plan.requirements_recheck, true);
  const { errors } = checkRequirementsDocument({ requirements: OLD, stage: 'requirements-fix', complete: true });
  for (const error of errors) assert.ok(plan.feedback.includes(error.message), error.code);
  assert.match(plan.feedback, /no user revision/);
  // A bounded-context other than the one awaiting approval is not reopened.
  await assert.rejects(resolveReopen({ root: workspace, session: join(workspace, '.io'), state, ownerStage: 'requirements-fix', blockedExecutionId: 'subdomain-classification-1' }), /Reopen refused/);
});

test('a compliant document: the approval is accepted as before, and the recheck passes again after requirements-fix rewrote it (no loop)', async (t) => {
  const flow = await waiting(t, OLD);
  const { workspace, state } = flow;
  assert.equal(recheckRequirementsBeforeApproval({ root: workspace, state }).ok, false);
  // requirements-fix completes under the current rules (its own gate is the same call), then bounded-context fixes it again.
  await flow.write(document());
  const again = recheckRequirementsBeforeApproval({ root: workspace, state });
  assert.deepEqual({ applies: again.applies, ok: again.ok }, { applies: true, ok: true });
  assert.deepEqual(resolveReplyTarget(workspace, '승인합니다').args, ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '승인합니다']);
  const context = JSON.parse(run(workspace, 'harness-context.mjs', []).stdout);
  assert.match(context.next, /Ask whether to approve/);
  await assert.rejects(resolveReopen({ root: workspace, session: join(workspace, '.io'), state, ownerStage: 'requirements-fix', blockedExecutionId: 'bounded-context-1' }), /pass the current rules/);
});

test('a workflow whose domain-model already started or was approved is unaffected', async (t) => {
  const { workspace, state } = await waiting(t, OLD);
  assert.equal(recheckRequirementsBeforeApproval({ root: workspace, state }).applies, true);
  for (const design of [{ status: 'running', execution_id: 'domain-model-1' }, { status: 'failed', code: 'EXECUTION_ERROR', execution_id: 'domain-model-1', requirements_approval: 'bounded-context-1' }]) {
    const started = { ...state, stages: { ...state.stages, 'domain-model': design } };
    assert.deepEqual(recheckRequirementsBeforeApproval({ root: workspace, state: started }), { applies: false });
  }
  const stale = { ...state, stages: { ...state.stages, 'bounded-context': { ...state.stages['bounded-context'], stale: { owner_stage: 'requirements-fix' } } } };
  assert.deepEqual(recheckRequirementsBeforeApproval({ root: workspace, state: stale }), { applies: false }, 'a stale result is revalidated by the normal order');
  assert.deepEqual(recheckRequirementsBeforeApproval({ root: workspace, state: { ...state, current_stage: 'domain-model' } }), { applies: false });
});
