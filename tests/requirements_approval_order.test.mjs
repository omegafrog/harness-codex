import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRequirementsApproval, inspectUserReply } from '../.harness/src/workflow/user-inputs.mjs';
import { explainError, finishNext } from '../.harness/src/workflow/stage-cli.mjs';
import { REQUIREMENTS_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';
import { codexTranscript, codexUserPrompt } from './support/codex-user-prompt.mjs';

const REQUEST = '게시글 삭제 기능';
const at = (minute) => `2026-11-21T09:${String(minute).padStart(2, '0')}:00.000Z`;
const done = (executionId, minute, extra = {}) => ({ status: 'completed', code: 'OK', execution_id: executionId, started_at: at(minute - 1), finished_at: at(minute), ...extra });
const ASK = /Show the user result\.summary \(the approval summary\) and the requirements\.md path/;
const REFUSED = /Requirements approval answer was not recorded/;

// A headless `codex exec resume` is one more user turn in the same rollout: its first message is the resume request and
// every later message is whatever the user sent after the orchestrator's last reply.
test('requirements approval is asked once the draft is settled, and a reply sent before that is never recorded as approval', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, specPath } = flow;
  const requirements = specPath('requirements.md');
  await mkdir(join(workspace, requirements, '..'), { recursive: true });
  await writeFile(join(workspace, requirements), '# 요구사항 명세\n\n- 상태: draft\n');

  // The timeline of a resumed session: the resume request, the answer to the requirements-fix questions, and an
  // approval typed while the requirements were still being completed.
  await codexUserPrompt(workspace, '계속 진행해', { at: at(0) });
  await codexUserPrompt(workspace, '권장', { at: at(3) });
  await codexUserPrompt(workspace, '요구사항 승인합니다', { at: at(4) });
  const approve = (state, answer, executionId = state.stages['bounded-context']?.execution_id, stage = 'domain-model') =>
    assertRequirementsApproval({ root: workspace, state, stage, planSetId, approval: { execution_id: executionId, answer } });

  // 1. The draft is not settled: bounded-context has not run, so there is nothing to approve yet.
  const drafting = { stages: { 'requirements-fix': done('requirements-fix-1', 5) } };
  for (const answer of ['요구사항 승인합니다', '권장', '계속 진행해']) await assert.rejects(approve(drafting, answer, 'bounded-context-1'), REFUSED);

  // 2. bounded-context settles the document at 09:08. The earlier "approval" and the resume request were sent before
  // it, so they are not the user's answer to the fixed requirements.
  const fixed = { stages: { 'requirements-fix': done('requirements-fix-1', 5), 'bounded-context': done('bounded-context-1', 8) } };
  for (const answer of ['요구사항 승인합니다', '권장', '계속 진행해']) await assert.rejects(approve(fixed, answer), REFUSED, `${answer} was sent before the draft was settled`);
  await assert.rejects(approve(fixed, '요구사항 승인합니다', 'bounded-context-0'), REFUSED, 'an approval names the execution that fixed the requirements');
  await assert.rejects(assertRequirementsApproval({ root: workspace, state: fixed, stage: 'domain-model', planSetId }), REFUSED, 'without a reply there is no approval');

  // 3. The user reads the fixed requirements, asks a question and only then approves.
  await codexUserPrompt(workspace, '이 규칙의 예외는 무엇인가요?', { at: at(9) });
  await codexUserPrompt(workspace, '이대로 승인합니다', { at: at(12) });
  await approve(fixed, '이대로 승인합니다');
  await assert.rejects(approve(fixed, '이 규칙의 예외는 무엇인가요?x'), REFUSED, 'only words the user actually sent count');
  await assert.rejects(approve({ stages: { ...fixed.stages, 'bounded-context': { ...fixed.stages['bounded-context'], stale: { owner_stage: 'requirements-fix' } } } }, '이대로 승인합니다'), REFUSED, 'a stale result cannot be approved');

  // 4. The user changes the requirements after approving: the new bounded-context run needs its own, later approval.
  const approved = { stages: { ...fixed.stages, 'domain-model': { ...done('domain-model-1', 14), requirements_approval: 'bounded-context-1' } } };
  await assert.doesNotReject(assertRequirementsApproval({ root: workspace, state: approved, stage: 'domain-model', planSetId }), 'the recorded approval keeps covering the design it was given for');
  const revised = { stages: { ...approved.stages, 'bounded-context': done('bounded-context-2', 20) } };
  await assert.rejects(assertRequirementsApproval({ root: workspace, state: revised, stage: 'domain-model', planSetId }), REFUSED, 'the earlier approval does not cover the revised requirements');
  await assert.rejects(approve(revised, '이대로 승인합니다'), REFUSED);
  await codexUserPrompt(workspace, '수정된 요구사항을 승인합니다', { at: at(25) });
  await approve(revised, '수정된 요구사항을 승인합니다');
});

test('only the completion of bounded-context asks for requirements approval', () => {
  const next = (stageId, fields = {}) => finishNext({ status: 'completed', code: 'OK', stageId, executionId: `${stageId}-1`, ...fields });
  for (const stage of REQUIREMENTS_STAGES.filter((id) => id !== 'bounded-context')) {
    assert.doesNotMatch(next(stage), ASK, `${stage} leaves the requirements as a draft`);
    assert.doesNotMatch(next(stage), /--requirements-approved/);
    assert.match(finishNext({ status: 'action_required', code: 'USER_DECISION_REQUIRED', stageId: stage, executionId: `${stage}-1` }), /Show result\.questions to the user in Korean/);
  }
  assert.match(next('requirements-fix'), /Next stage: .*--stage-id bounded-context/, 'after the last fill the next step is bounded-context, not an approval');
  const ask = next('bounded-context');
  assert.match(ask, ASK);
  assert.match(ask, /--requirements-approved true --approval-answer/);
  assert.match(ask, /Only after the user's own approval/);
  assert.doesNotMatch(next('bounded-context', { requirementsPresent: false }), ASK, 'a skipped requirements flow has nothing to approve');
  for (const [status, code] of [['blocked', 'DEPENDENCY_INCOMPLETE'], ['failed', 'HARNESS_ERROR'], ['action_required', 'USER_DECISION_REQUIRED']]) {
    assert.doesNotMatch(finishNext({ status, code, stageId: 'bounded-context', executionId: 'bounded-context-1' }), ASK, `bounded-context ${status}/${code} has no fixed requirements yet`);
  }
});

test('a resumed session is told to ask for approval only while bounded-context is the settled current stage', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, specPath, invoke } = flow;
  const requirements = specPath('requirements.md');
  await mkdir(join(workspace, requirements, '..'), { recursive: true });
  await writeFile(join(workspace, requirements), '# 요구사항 명세\n\n- 상태: draft\n');
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const base = JSON.parse(await readFile(statePath, 'utf8'));
  const resume = async (current_stage, stages) => {
    await writeFile(statePath, JSON.stringify({ ...base, current_stage, stages: { ...base.stages, ...stages } }));
    return invoke(workspace, 'harness-context.mjs', []).next ?? null;
  };
  assert.equal(await resume('requirements-fix', { 'requirements-fix': done('requirements-fix-1', 5) }), null, 'a completed draft continues to bounded-context without an approval question');
  assert.equal(await resume('bounded-context', { 'requirements-fix': done('requirements-fix-1', 5), 'bounded-context': { status: 'waiting', code: 'USER_DECISION_REQUIRED', execution_id: 'bounded-context-1' } }), null, 'questions of bounded-context come first');
  const settled = await resume('bounded-context', { 'requirements-fix': done('requirements-fix-1', 5), 'bounded-context': done('bounded-context-1', 8) });
  assert.match(settled, ASK, 'a new `codex exec resume` after bounded-context asks for the approval before anything else');
  assert.match(settled, /standalone `\$orchestrator <approval>`/);
  assert.equal(await resume('domain-model', { 'bounded-context': done('bounded-context-1', 8), 'domain-model': done('domain-model-1', 14, { requirements_approval: 'bounded-context-1' }) }), null, 'once tactical design has started the approval is not asked again');
});

// Attempt 025: the approval form was answered in an outer session and the headless resume sent the same text as a plain
// prompt, without the `$orchestrator` command. The transcript held it, but the guard accepted only orchestrator requests
// and form replies, and its refusal named neither the transcript nor the reason.
test('a refused approval names the transcript it searched and why the matching message failed; the accepted forms stay unchanged', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, specPath } = flow;
  await mkdir(join(workspace, specPath('requirements.md'), '..'), { recursive: true });
  await writeFile(join(workspace, specPath('requirements.md')), '# 요구사항 명세\n\n- 상태: draft\n');
  const APPROVAL = '승인 · 다음 단계 진행';
  const fixed = { stages: { 'bounded-context': done('bounded-context-1', 8) } };
  const approve = (answer, state = fixed) => assertRequirementsApproval({ root: workspace, state, stage: 'domain-model', planSetId, approval: { execution_id: state.stages['bounded-context'].execution_id, answer } });
  const refusal = async (answer, state) => { try { await approve(answer, state); } catch (error) { return error; } assert.fail(`${answer} was recorded`); };

  // No transcript exists yet for the registered owner conversation.
  const missing = await refusal(APPROVAL);
  assert.match(missing.message, REFUSED);
  assert.equal(missing.approval_search.outcome, 'no_transcript');
  assert.match(missing.message, /no transcript file exists for that session/);

  // The orchestrator's own words and an unrelated message are not candidates; the refusal counts what the user did send.
  const transcript = await codexTranscript(workspace);
  await codexUserPrompt(workspace, '이 규칙의 예외는 무엇인가요?', { at: at(9) });
  await appendFile(transcript, JSON.stringify({ timestamp: at(9), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: APPROVAL }] } }) + '\n');
  const unrelated = await refusal(APPROVAL);
  assert.equal(unrelated.approval_search.outcome, 'no_matching_message');
  assert.deepEqual(unrelated.approval_search.candidates, []);
  assert.deepEqual(unrelated.approval_search.counts, { orchestrator_requests: 1, plain_user_messages: 0, form_replies: 0 });
  assert.match(unrelated.message, /found no message with that text\. In that window the user sent 1 orchestrator request\(s\), 0 plain message\(s\) and 0 form reply\(ies\)/);

  // 1. The user's own words as a plain message: the guard names the message, its time and the missing command.
  await codexUserPrompt(workspace, APPROVAL, { at: at(10), prefix: '' });
  const plain = await refusal(APPROVAL);
  assert.match(plain.message, REFUSED);
  assert.deepEqual(plain.approval_search.candidates, [{ at: at(10), form: 'plain_user_message', problems: ['missing_orchestrator_prefix'] }]);
  assert.equal(plain.approval_search.transcript, transcript);
  assert.equal(plain.approval_search.since, at(8));
  assert.equal(plain.approval_search.wanted, APPROVAL);
  assert.ok(transcript && plain.message.includes(transcript), 'the refusal names the transcript it searched');
  assert.ok(plain.message.includes(`plain user message at ${at(10)} with exactly that text, but it has no leading \`$orchestrator\` (Codex) or \`/orchestrator\` (Claude Code)`), plain.message);
  const explained = explainError(plain, { root: workspace, stageId: 'domain-model' });
  assert.equal(explained.code, 'PRECONDITION');
  assert.ok(explained.why.includes(`plain user message at ${at(10)} with exactly that text has no leading`), explained.why);
  assert.match(explained.user_decision, /`\$orchestrator <reply>` \(Codex; headless: `codex exec resume <session-id> '\$orchestrator <reply>'`\) or `\/orchestrator <reply>` \(Claude Code\)/);
  assert.match(explained.user_decision, /Not accepted: a plain message without the prefix, a reply collected in another conversation/);
  assert.ok(explained.user_decision.includes(`already in the owner transcript as a plain message, so do not ask a new question: ask them to send the same text as \`$orchestrator ${APPROVAL}\` (Claude Code: \`/orchestrator ${APPROVAL}\`)`), explained.user_decision);
  assert.deepEqual(explained.approval_search, plain.approval_search);
  assert.equal(explained.next, undefined);
  // The same refusal reaches the orchestrator through the child command's JSON, so nothing depends on an Error object.
  assert.deepEqual(JSON.parse(JSON.stringify(explained)).approval_search.candidates, plain.approval_search.candidates);

  // 2. A plain message does not become approval by repetition, and a bare flag or another execution never matches.
  await codexUserPrompt(workspace, APPROVAL, { at: at(11), prefix: '' });
  assert.equal((await refusal(APPROVAL)).approval_search.candidates.length, 2);
  assert.match((await refusal(undefined)).message, /^Requirements approval answer was not recorded: the passed --approval-answer is empty or not text$/);
  assert.match((await assertRequirementsApproval({ root: workspace, state: fixed, stage: 'domain-model', planSetId, approval: null }).catch((error) => error)).message, /no --approval-answer was passed; a bare --requirements-approved flag is not approval/);
  assert.match((await assertRequirementsApproval({ root: workspace, state: { stages: {} }, stage: 'domain-model', planSetId, approval: { execution_id: 'bounded-context-1', answer: APPROVAL } }).catch((error) => error)).message, /bounded-context has not fixed the current requirements \(never run\)/);
  assert.match((await assertRequirementsApproval({ root: workspace, state: fixed, stage: 'domain-model', planSetId, approval: { execution_id: 'bounded-context-0', answer: APPROVAL } }).catch((error) => error)).message, /names bounded-context bounded-context-0 but the current fixed requirements come from bounded-context-1/);

  // 3. The same words sent as an orchestrator request after the gate are the user's approval. This is the accepted form.
  await codexUserPrompt(workspace, APPROVAL, { at: at(12) });
  await approve(APPROVAL);
  const accepted = await inspectUserReply({ root: workspace, text: APPROVAL, since: at(8) });
  assert.equal(accepted.matched, true);
  assert.equal(accepted.search.outcome, 'matched');

  // 4. A message that predates the gate or came from another directory names that reason instead.
  const later = { stages: { 'bounded-context': done('bounded-context-2', 20) } };
  const stale = await refusal(APPROVAL, later);
  assert.equal(stale.approval_search.since, at(20));
  assert.deepEqual(stale.approval_search.candidates.at(-1), { at: at(12), form: 'orchestrator_request', problems: ['sent_before_gate'] });
  assert.match(explainError(stale, { root: workspace, stageId: 'domain-model' }).user_decision, /predates the gate, so it is not approval of the current result: show the current result and ask again/);
  await appendFile(transcript, JSON.stringify({ timestamp: at(21), type: 'turn_context', payload: { cwd: '/somewhere/else' } }) + '\n');
  await codexUserPrompt(workspace, APPROVAL, { at: at(22) });
  const elsewhere = await refusal(APPROVAL, later);
  assert.deepEqual(elsewhere.approval_search.candidates.at(-1), { at: at(22), form: 'orchestrator_request', problems: ['other_workspace'], cwd: '/somewhere/else' });
  await appendFile(transcript, JSON.stringify({ timestamp: at(23), type: 'turn_context', payload: { cwd: workspace } }) + '\n');
  await codexUserPrompt(workspace, APPROVAL, { at: at(24) });
  await approve(APPROVAL, later);

  // 5. Only the registered owner conversation is read.
  const foreign = await inspectUserReply({ root: workspace, text: APPROVAL, since: at(8), sessionId: '11111111-1111-4111-8111-111111111111', provider: 'codex' });
  assert.equal(foreign.matched, false);
  assert.equal(foreign.search.outcome, 'not_owner_session');
  assert.match(explainError(Object.assign(new Error('Requirements approval answer was not recorded: x'), { approval_search: foreign.search }), { root: workspace, stageId: 'domain-model' }).user_decision, /Continue in the owner conversation \(codex session /);
  // The publication gate keeps its own whole-message allowlist of plain approvals; any other plain text is still refused.
  await codexUserPrompt(workspace, '승인합니다', { at: at(30), prefix: '' });
  await codexUserPrompt(workspace, '발행해도 좋습니다 그런데 먼저 확인', { at: at(31), prefix: '' });
  assert.equal((await inspectUserReply({ root: workspace, text: '승인합니다', since: at(25), allowExplicitPublicationReply: true })).matched, true);
  assert.equal((await inspectUserReply({ root: workspace, text: '승인합니다', since: at(25) })).matched, false);
  const publication = await inspectUserReply({ root: workspace, text: '발행해도 좋습니다 그런데 먼저 확인', since: at(25), allowExplicitPublicationReply: true });
  assert.equal(publication.matched, false);
  assert.equal(publication.search.candidates[0].problems[0], 'missing_orchestrator_prefix');
});

test('the installed consumer carries the approval search module and Doctor names it when it is missing', async (t) => {
  const { primary, workspace } = await consumerWorkflow(t, REQUEST);
  const missing = async () => (await runDoctor({ root: primary, sourceRoot })).diagnostics.filter((item) => item.code === 'execution_asset_missing' && /approval-search\.mjs/.test(item.message));
  for (const root of [primary, workspace]) assert.match(await readFile(join(root, '.harness/src/workflow/approval-search.mjs'), 'utf8'), /export function describeReplySearch/);
  assert.deepEqual(await missing(), []);
  await rm(join(primary, '.harness/src/workflow/approval-search.mjs'));
  assert.equal((await missing()).length, 1);
});
