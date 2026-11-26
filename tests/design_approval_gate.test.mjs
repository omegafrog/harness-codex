import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertDesignApproval } from '../.harness/src/workflow/user-inputs.mjs';
import { resolveApproval, resolveReplyTarget, resolveRevision } from '../.harness/src/workflow/answer-text.mjs';
import { explainError, finishNext } from '../.harness/src/workflow/stage-cli.mjs';
import { DESIGN_APPROVAL_CHAIN, PRE_SPEC_STAGES, TACTICAL_DESIGN_STAGES, pendingDesignApproval } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow } from './support/consumer-workflow.mjs';
import { codexUserPrompt } from './support/codex-user-prompt.mjs';

const REFUSED = /Design approval answer was not recorded/;
const flags = (answer) => ['--design-approved', 'true', '--approval-answer', answer];
const done = (id, minute, extra = {}) => ({ status: 'completed', code: 'OK', execution_id: id, started_at: `2026-11-26T09:${minute}:00.000Z`, finished_at: `2026-11-26T09:${minute}:30.000Z`, ...extra });

test('each design stage after domain-model and tactical-technology needs approval of the previous current result', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, runStage, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  const skipped = { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false };
  for (const stage of PRE_SPEC_STAGES.slice(1, PRE_SPEC_STAGES.indexOf('domain-model') + 1)) await runStage(stage, skipped);

  const refuse = (args, why) => {
    const result = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--verbose', '--stage-id', 'aggregate-design', ...args], { cwd: workspace, encoding: 'utf8' });
    assert.notEqual(result.status, 0, why);
    assert.match(result.stdout + result.stderr, REFUSED, why);
    return result.stdout + result.stderr;
  };
  assert.match(refuse([], 'a plain launch is refused'), /ask the user/i);
  refuse(flags('설계를 승인합니다'), 'words the user never said are refused');
  await codexUserPrompt(workspace, '설계를 승인합니다');
  const first = await runStage('aggregate-design', { ...skipped, extraArgs: flags('설계를 승인합니다') });
  assert.equal(first.prepared.input.context.design_approval.stage_id, 'domain-model');
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const read = async () => JSON.parse(await readFile(statePath, 'utf8'));
  let state = await read();
  const receipt = state.stages['aggregate-design'].design_approval;
  assert.deepEqual(receipt, { stage_id: 'domain-model', execution_id: state.stages['domain-model'].execution_id, answer: '설계를 승인합니다' });

  // The recorded approval covers a retry of the same stage, and stops covering once the previous stage has a new result.
  const check = (stages, approval = null) => assertDesignApproval({ root: workspace, state: { stages }, stage: 'aggregate-design', planSetId: flow.planSetId, approval });
  const retry = { ...state.stages, 'aggregate-design': { ...state.stages['aggregate-design'], status: 'failed', code: 'STAGE_FAILED' } };
  await check(retry);
  assert.equal(pendingDesignApproval({ 'domain-model': retry['domain-model'], 'aggregate-design': retry['aggregate-design'] }), null);
  const rerun = { ...retry, 'domain-model': { ...retry['domain-model'], execution_id: 'domain-model-rerun', finished_at: new Date().toISOString() } };
  await assert.rejects(check(rerun), REFUSED);
  await assert.rejects(check(rerun, receipt), REFUSED);
  await assert.rejects(check(rerun, { ...receipt, execution_id: 'domain-model-rerun' }), REFUSED, 'a reply sent before the rerun finished does not approve it');
  await codexUserPrompt(workspace, '다시 만든 설계를 승인합니다', { at: new Date(Date.now() + 1000).toISOString() });
  await check(rerun, { stage_id: 'domain-model', execution_id: 'domain-model-rerun', answer: '다시 만든 설계를 승인합니다' });
});

test('a declared approval launches the next stage', () => {
  for (const [index, source] of TACTICAL_DESIGN_STAGES.entries()) {
    const target = DESIGN_APPROVAL_CHAIN[index + 1];
    const stages = Object.fromEntries(TACTICAL_DESIGN_STAGES.slice(0, index + 1).map((id, i) => [id, done(`${id}-1`, 10 + i, i ? { design_approval: { stage_id: TACTICAL_DESIGN_STAGES[i - 1], execution_id: `${TACTICAL_DESIGN_STAGES[i - 1]}-1` } } : {})]));
    const routed = resolveApproval({ stages }, '승인합니다');
    assert.deepEqual(routed, { stageId: target, args: ['--stage-id', target, '--design-approved', 'true', '--approval-answer', '승인합니다'], approval: 'design' }, source);
    const stale = { ...stages, [target]: done(`${target}-0`, '01', { stale: { owner_stage: source }, design_approval: { stage_id: source, execution_id: `${source}-0` } }) };
    assert.equal(resolveApproval({ stages: stale }, '승인합니다').stageId, target, 'a rerun needs a new approval');
  }
});

test('a completed design stage asks for approval and a refusal explains how to get it', () => {
  for (const [index, stageId] of TACTICAL_DESIGN_STAGES.entries()) {
    const target = DESIGN_APPROVAL_CHAIN[index + 1];
    for (const provider of ['codex', 'claude-code']) {
      const next = finishNext({ status: 'completed', code: 'OK', stageId, executionId: `${stageId}-1`, provider });
      assert.ok(next.includes(`Do not start ${target} yet`), next);
      assert.match(next, /result\.summary and the artifact paths/);
      assert.match(next, /확인할 결정·해석/);
      assert.match(next, provider === 'codex' ? /--user-revision true/ : /harness-stage: revise/);
      assert.doesNotMatch(finishNext({ status: 'completed', code: 'OK', stageId, executionId: `${stageId}-1`, provider, designApprovalNeeded: false }), /Do not start/);
    }
  }
  const explained = explainError(Object.assign(new Error('Design approval answer was not recorded: no reply'), { design_stage: 'domain-service' }), { stage: 'domain-service' });
  assert.match(JSON.stringify(explained), /--stage-id domain-service[^"]*--design-approved true/);
});

test('after a requirements reopen the stale design stages are approved again one by one through application-service', async (t) => {
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
