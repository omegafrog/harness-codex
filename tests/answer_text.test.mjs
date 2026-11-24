import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecommendedReply, mapReplyToAnswers } from '../.harness/src/workflow/answer-text.mjs';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const ask = (id, title, recommended = 'a') => withDecisionContext({
  question_id: id, title, recommended_option_id: recommended, rationale: '근거', decision_kind: null,
  options: [{ id: 'a', label: '핀 하나씩', consequence: '핀마다' }, { id: 'b', label: '소유자 묶음', consequence: '소유자마다' }, { id: 'c', label: '지도 전체', consequence: '전체' }].map((option) => ({ ...option, evidence: [] })),
});
const questions = [ask('q:1', '공개 단위는?', 'a'), ask('q:2', '삭제 권한은?', 'b'), ask('q:3', '복구는?', 'c')];
const answerOf = (mapped, id) => mapped.answers.find(({ question_id }) => question_id === id).answer;

test('an all-recommended reply answers every open question with its recommended option', () => {
  for (const reply of ['추천대로', '추천대로 해줘', '모두 추천', '전부 추천안으로', 'all recommended', 'Recommended.', '다 추천']) assert.equal(isRecommendedReply(reply), true, reply);
  for (const reply of ['추천은 별로야', '1번 추천', '네', 'B']) assert.equal(isRecommendedReply(reply), false, reply);
  const mapped = mapReplyToAnswers(questions, '추천대로');
  assert.deepEqual(mapped.answers, [
    { question_id: 'q:1', answer: '핀 하나씩 (a)' }, { question_id: 'q:2', answer: '소유자 묶음 (b)' }, { question_id: 'q:3', answer: '지도 전체 (c)' },
  ]);
  // Only the questions still open are answered, so a partial batch is completed without repeating an answer.
  assert.deepEqual(mapReplyToAnswers(questions, '추천대로', { answered: ['q:1', 'q:3'] }).answers, [{ question_id: 'q:2', answer: '소유자 묶음 (b)' }]);
  assert.match(mapReplyToAnswers([{ ...questions[0], recommended_option_id: 'zzz' }], '추천대로').clarification, /No recommended option is marked/);
});

test('a numbered reply picks the option of each question by number, letter, id or label and keeps the user\'s conditions', () => {
  assert.equal(answerOf(mapReplyToAnswers(questions, '1번 B, 2번 3, 3번 a'), 'q:1'), '소유자 묶음 (b)');
  const mapped = mapReplyToAnswers(questions, '1번 B, 2번 3, 3번 a');
  assert.equal(answerOf(mapped, 'q:2'), '지도 전체 (c)');
  assert.equal(answerOf(mapped, 'q:3'), '핀 하나씩 (a)');
  assert.equal(answerOf(mapReplyToAnswers(questions, '1: per_owner\n2: 추천\n3: c, 단 관리자만'), 'q:2'), '소유자 묶음 (b)');
  assert.equal(answerOf(mapReplyToAnswers(questions, '1: per_owner\n2: 추천\n3: c, 단 관리자만'), 'q:3'), '지도 전체 (c): 단 관리자만');
  // The reply may answer a subset; the rest stays waiting.
  assert.deepEqual(mapReplyToAnswers(questions, '2번 B').answers, [{ question_id: 'q:2', answer: '소유자 묶음 (b)' }]);
  // Out-of-order numbering and the user's own wording both survive.
  const free = mapReplyToAnswers(questions, '3번 복구는 7일 안에만 허용, 1번 A');
  assert.equal(answerOf(free, 'q:3'), '복구는 7일 안에만 허용');
  assert.equal(answerOf(free, 'q:1'), '핀 하나씩 (a)');
  // Answers that are already stored are not overwritten.
  assert.deepEqual(mapReplyToAnswers(questions, '1번 B, 2번 B', { answered: ['q:1'] }).answers, [{ question_id: 'q:2', answer: '소유자 묶음 (b)' }]);
});

test('a single open question takes the reply as its choice or as the user\'s own words', () => {
  assert.deepEqual(mapReplyToAnswers([questions[0]], 'B').answers, [{ question_id: 'q:1', answer: '소유자 묶음 (b)' }]);
  assert.deepEqual(mapReplyToAnswers([questions[0]], '2').answers, [{ question_id: 'q:1', answer: '소유자 묶음 (b)' }]);
  assert.deepEqual(mapReplyToAnswers([questions[0]], '핀 하나씩').answers, [{ question_id: 'q:1', answer: '핀 하나씩 (a)' }]);
  assert.deepEqual(mapReplyToAnswers([questions[0]], '핀은 하나씩 하되 비공개가 기본').answers, [{ question_id: 'q:1', answer: '핀은 하나씩 하되 비공개가 기본' }]);
});

test('an ambiguous reply is not guessed: it asks which question each choice answers', () => {
  for (const reply of ['B', '그걸로 해줘', '네 좋아요']) {
    const mapped = mapReplyToAnswers(questions, reply);
    assert.equal(mapped.answers, undefined, reply);
    assert.match(mapped.clarification, /does not say which question/);
    assert.match(mapped.clarification, /1\. 공개 단위는\? \| 2\. 삭제 권한은\? \| 3\. 복구는\?/);
  }
  assert.match(mapReplyToAnswers(questions, '   ').clarification, /empty/);
  assert.match(mapReplyToAnswers(questions, '추천대로', { answered: ['q:1', 'q:2', 'q:3'] }).clarification, /already has an answer/);
  assert.match(mapReplyToAnswers(questions, '4번 B').clarification, /does not say which question/, 'a number beyond the batch is not an answer');
});

test('answer --text finds the waiting stage, records the mapped answers and launches; ambiguity and partial replies record nothing or only the part', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, specPath } = flow;
  const stage = 'stakeholder-analysis';
  const native = (...args) => spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), ...args], { cwd: workspace, encoding: 'utf8' });
  const analysis = specPath('stakeholder-analysis.md');
  const begun = await flow.beginStage(stage);
  await flow.submitStage(begun, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', files: { [analysis]: stakeholderAnalysisDocument(REQUEST) }, questions: [ask('q-a', '공개 단위는?', 'a'), ask('q-b', '삭제 권한은?', 'b')] });
  const finished = flow.finishStage(begun);
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  const waiting = JSON.parse(finished.stdout);
  const [first, second] = waiting.result.questions;
  assert.equal(waiting.result.questions_path, undefined);
  assert.deepEqual(first.options.map(({ id, label, effect, recommended }) => ({ id, label, effect: typeof effect, recommended })), [
    { id: 'a', label: '핀 하나씩', effect: 'string', recommended: true }, { id: 'b', label: '소유자 묶음', effect: 'string', recommended: undefined }, { id: 'c', label: '지도 전체', effect: 'string', recommended: undefined },
  ]);
  const pending = join(workspace, '.io/runtime/executions', waiting.execution_id, 'pending-answers.json');

  // Ambiguous: nothing is recorded and the reply is not guessed.
  const unclear = native('answer', '--text', '그걸로 해줘');
  assert.equal(unclear.status, 0, unclear.stderr);
  const clarification = JSON.parse(unclear.stdout);
  assert.equal(clarification.status, 'clarification_needed');
  assert.equal(clarification.stage_id, stage);
  assert.match(clarification.message, /1\. .*\| 2\. /);
  assert.equal(existsSync(pending), false, 'no answer was recorded');

  // Partial: the answered question is stored, the other keeps waiting and is shown compactly.
  const partial = native('answer', '--text', `2번 c`);
  assert.equal(partial.status, 0, partial.stderr);
  const remaining = JSON.parse(partial.stdout);
  assert.equal(remaining.waiting_for_answers, true);
  assert.deepEqual(remaining.questions.map(({ question_id }) => question_id), [first.question_id]);
  assert.ok(remaining.questions[0].options[0].label, 'the remaining question is shown compactly');
  assert.match(remaining.next, /answer --text/);
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), [{ question_id: second.question_id, answer: '지도 전체 (c)' }]);

  // The rest as recommended: the stage launches again with both answers.
  const rest = native('answer', '--text', '추천대로');
  assert.equal(rest.status, 0, rest.stderr);
  const launched = JSON.parse(rest.stdout);
  assert.equal(launched.status, 'launched');
  assert.equal(launched.answered, true);
  const stored = JSON.parse(await readFile(launched.answers_path, 'utf8'));
  assert.deepEqual(stored.sort((x, y) => x.question_id.localeCompare(y.question_id)), [{ question_id: first.question_id, answer: '핀 하나씩 (a)' }, { question_id: second.question_id, answer: '지도 전체 (c)' }]);

  // Nothing is waiting any more.
  const none = native('answer', '--text', '추천대로');
  assert.notEqual(none.status, 0);
  assert.equal(JSON.parse(none.stderr).code, 'ANSWER_REFUSED');
  assert.match(none.stderr, /No stage is waiting|waiting for/);
  assert.notEqual(native('answer').status, 0, 'a reply is required');
});

test('answer --text routes an approval reply to the requirements approval and keeps the approval-term check', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace } = flow;
  const answer = (text) => spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), 'answer', '--text', text], { cwd: workspace, encoding: 'utf8' });
  // Nothing has completed, so no gate waits for an approval.
  assert.equal(JSON.parse(answer('승인합니다').stderr).code, 'ANSWER_REFUSED');
  // With bounded-context completed the reply is the approval: the existing check still refuses an unrecorded reply.
  const { resolveReplyTarget } = await import('../.harness/src/workflow/answer-text.mjs');
  const { writeFile, readFile: read } = await import('node:fs/promises');
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await read(statePath, 'utf8'));
  state.stages['bounded-context'] = { status: 'completed', code: 'OK', execution_id: 'bounded-context-1', result_ref: 'runtime/executions/bounded-context-1/result.json', result_session_directory: join(workspace, '.io') };
  await writeFile(statePath, JSON.stringify(state));
  const target = resolveReplyTarget(workspace, '요구사항 승인합니다');
  assert.deepEqual(target.args, ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '요구사항 승인합니다']);
  assert.equal(target.approval, 'requirements');
  state.stages['to-ticket'] = { status: 'completed', code: 'OK', execution_id: 'to-ticket-1', result_ref: 'x', result_session_directory: join(workspace, '.io') };
  state.stages['domain-model'] = { status: 'completed', code: 'OK', execution_id: 'domain-model-1', result_ref: 'x', result_session_directory: join(workspace, '.io') };
  await writeFile(statePath, JSON.stringify(state));
  assert.deepEqual(resolveReplyTarget(workspace, '발행 승인').args.slice(0, 5), ['--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer']);
});
