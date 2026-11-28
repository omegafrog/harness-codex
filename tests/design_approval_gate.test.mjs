import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertDesignApproval } from '../.harness/src/workflow/user-inputs.mjs';
import { resolveApproval, resolveReplyTarget, resolveRevision } from '../.harness/src/workflow/answer-text.mjs';
import { explainError, finishNext } from '../.harness/src/workflow/stage-cli.mjs';
import { DESIGN_APPROVAL_PAIRS, PRE_SPEC_STAGES, TACTICAL_DESIGN_STAGES, pendingDesignApproval } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow } from './support/consumer-workflow.mjs';
import { codexUserPrompt } from './support/codex-user-prompt.mjs';

const REFUSED = /Design approval answer was not recorded/;
const flags = (answer) => ['--design-approved', 'true', '--approval-answer', answer];
const done = (id, minute, extra = {}) => ({ status: 'completed', code: 'OK', execution_id: id, started_at: `2026-11-26T09:${minute}:00.000Z`, finished_at: `2026-11-26T09:${minute}:30.000Z`, ...extra });

test('only the completed design requires approval before tickets', async () => {
  const stages = { 'tactical-data': done('data-1', 10) };
  await assert.rejects(assertDesignApproval({ root: process.cwd(), state: { stages }, stage: 'to-ticket', planSetId: 'set' }), REFUSED);
  for (const stage of ['aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary', 'tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data']) {
    await assertDesignApproval({ root: process.cwd(), state: { stages }, stage, planSetId: 'set' });
  }
  assert.equal(pendingDesignApproval(stages), 'to-ticket');
  const covered = { ...stages, 'to-ticket': { ...done('ticket-1', 11), design_approval: { stage_id: 'tactical-data', execution_id: 'data-1' } } };
  assert.equal(pendingDesignApproval(covered), null);
  await assert.rejects(assertDesignApproval({ root: process.cwd(), state: { stages: { ...covered, 'tactical-data': done('data-2', 12) } }, stage: 'to-ticket', planSetId: 'set' }), REFUSED);
});

test('approval points route to the selected next stage', () => {
  for (const [source, target] of DESIGN_APPROVAL_PAIRS) {
    const stages = { [source]: done(`${source}-1`, 10) };
    const routed = resolveApproval({ stages }, '승인합니다');
    assert.equal(routed.stageId, target, source);
    assert.equal(routed.approval, 'design');
    assert.match(finishNext({ status: 'completed', code: 'OK', stageId: source, executionId: source }), /Do not start/);
  }
  for (const [stageId, target] of [['domain-model', 'aggregate-design'], ['aggregate-design', 'domain-service'], ['domain-service', 'application-service'], ['application-service', 'integration-design'], ['integration-design', 'context-boundary'], ['context-boundary', 'tactical-technology'], ['tactical-technology', 'tactical-ui'], ['tactical-ui', 'tactical-api'], ['tactical-api', 'tactical-data']]) {
    const next = finishNext({ status: 'completed', code: 'OK', stageId, executionId: stageId, designApprovalNeeded: false });
    assert.match(next, /without asking for stage approval/);
    assert.ok(next.includes(target));
  }
});

test('a generic stage approval routes to its next stage', () => {
  const stages = { 'stakeholder-analysis': done('stakeholder-analysis-1', 10) };
  const routed = resolveApproval({ current_stage: 'stakeholder-analysis', stages }, '그 결과로 진행해');
  assert.deepEqual(routed, { stageId: 'subdomain-candidates', args: ['--stage-id', 'subdomain-candidates'], approval: 'stage' });
  const stale = { ...stages, 'ubiquitous-language': done('ubiquitous-language-1', 11, { stale: { owner_stage: 'stakeholder-analysis', blocked_stage: 'bounded-context' } }) };
  assert.equal(resolveApproval({ current_stage: 'stakeholder-analysis', stages: stale }, '승인').stageId, 'ubiquitous-language');
});

test('after a requirements reopen design stages resume without intermediate approvals', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, runStage, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  const skipped = { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false };
  const design = ['domain-model', 'aggregate-design', 'domain-service', 'application-service'];
  for (const stage of [...PRE_SPEC_STAGES.slice(1, PRE_SPEC_STAGES.indexOf('domain-model') + 1), 'aggregate-design', 'domain-service']) await runStage(stage, skipped);
  const blocked = await runStage('application-service', { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '요구사항 누락', resultExtra: { owner_stage: 'requirements-fix', dependency_gap: '삭제 권한 규칙이 없다' }, expectCommit: false });
  // A changed result keeps the downstream results stale; an identical one would retain them.
  await runStage('requirements-fix', { ...skipped, summary: `${skipped.summary} - 삭제 권한 보완`, extraArgs: ['--reopen-for', blocked.prepared.input.execution_id] });
  await runStage('bounded-context', skipped);

  const read = async () => JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  for (const id of design) assert.ok((await read()).stages[id].stale, id);
  let minute = 0;
  for (const [index, target] of design.entries()) {
    if (index > 0) {
      await runStage(target, skipped);
      assert.equal((await read()).stages[target].stale, undefined, target);
      continue;
    }
    const reply = '승인하고 계속 해봐';
    const revised = resolveRevision(workspace, '삭제 규칙을 바꿔 줘', 'requirements-fix');
    assert.equal(revised.revision, true, target);
    await codexUserPrompt(workspace, reply, { at: new Date(Date.now() + 1000 * ++minute).toISOString() });
    const routed = resolveReplyTarget(workspace, reply, { intent: 'approve' });
    const kind = index ? 'design' : 'requirements';
    assert.deepEqual(routed, { stageId: target, args: ['--stage-id', target, `--${kind}-approved`, 'true', '--approval-answer', reply], approval: kind }, target);
    await runStage(target, { ...skipped, extraArgs: routed.args.slice(2) });
    const { stages } = await read();
    assert.equal(stages[target].stale, undefined, target);
    if (index) assert.equal(stages[target].design_approval.execution_id, stages[design[index - 1]].execution_id, target);
    else assert.equal(stages[target].requirements_approval, stages['bounded-context'].execution_id);
  }
});
