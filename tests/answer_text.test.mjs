import { tmpdir } from 'node:os';
import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredAnswers, resolveApproval, resolveRevision } from '../.harness/src/workflow/answer-text.mjs';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const REQUEST = '게시글 삭제 기능을 추가해줘';
const ask = (id, title, recommended = 'a') => withDecisionContext({
  question_id: id, title, recommended_option_id: recommended, rationale: '근거', decision_kind: null,
  options: [{ id: 'a', label: '핀 하나씩', consequence: '핀마다' }, { id: 'b', label: '소유자 묶음', consequence: '소유자마다' }, { id: 'c', label: '지도 전체', consequence: '전체' }].map((option) => ({ ...option, evidence: [] })),
});
const questions = [ask('q:1', '공개 단위는?', 'a'), ask('q:2', '삭제 권한은?', 'b'), ask('q:3', '복구는?', 'c')];
const pick = (question_id, option_id) => ({ question_id, option_id });

test('recommended is a declared intent that answers every open question with its recommended option', () => {
  assert.deepEqual(declaredAnswers(questions, { recommended: true }).answers, [
    { question_id: 'q:1', answer: '핀 하나씩 (a)' }, { question_id: 'q:2', answer: '소유자 묶음 (b)' }, { question_id: 'q:3', answer: '지도 전체 (c)' },
  ]);
  // Only the questions still open are answered, so a partial batch is completed without repeating an answer.
  assert.deepEqual(declaredAnswers(questions, { recommended: true, answered: ['q:1', 'q:3'] }).answers, [{ question_id: 'q:2', answer: '소유자 묶음 (b)' }]);
  assert.match(declaredAnswers([{ ...questions[0], recommended_option_id: 'zzz' }], { recommended: true }).clarification, /recommended option/);
});

test('declared choices are checked against the open questions and option ids, never against wording', () => {
  assert.deepEqual(declaredAnswers(questions, { choices: JSON.stringify([pick('q:1', 'b'), { question_id: 'q:2', option_id: 'a', text: '관리자만' }, { question_id: 'q:3', text: '아직 모르겠어' }]) }).answers, [
    { question_id: 'q:1', answer: '소유자 묶음 (b)' }, { question_id: 'q:2', answer: '핀 하나씩 (a): 관리자만' }, { question_id: 'q:3', answer: '아직 모르겠어' },
  ]);
  for (const choices of [null, 'not json', '[]', [pick('q:9', 'a')], [pick('q:1', 'z')], [{ question_id: 'q:1' }], [pick('q:1', 'a'), pick('q:1', 'b')]]) {
    const refused = declaredAnswers(questions, { choices });
    assert.equal(refused.answers, undefined, JSON.stringify(choices));
    assert.match(refused.clarification, /q:1 "공개 단위는\?" \(options: a, b, c\)/);
  }
  assert.match(declaredAnswers(questions, { choices: [pick('q:1', 'a')], answered: ['q:1'] }).clarification, /not an open question/);
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

  // Undeclared: nothing is recorded and the reply is not interpreted.
  const unclear = native('answer', '--text', '2번 c');
  assert.equal(unclear.status, 0, unclear.stderr);
  const clarification = JSON.parse(unclear.stdout);
  assert.equal(clarification.status, 'clarification_needed');
  assert.equal(clarification.stage_id, stage);
  assert.ok(clarification.message.includes(first.question_id) && clarification.message.includes(second.question_id), clarification.message);
  assert.equal(existsSync(pending), false, 'no answer was recorded');

  // Partial: the answered question is stored, the other keeps waiting and is shown compactly.
  const partial = native('answer', '--text', '두 번째는 지도로', '--choices', JSON.stringify([pick(second.question_id, 'c')]));
  assert.equal(partial.status, 0, partial.stderr);
  const remaining = JSON.parse(partial.stdout);
  assert.equal(remaining.waiting_for_answers, true);
  assert.deepEqual(remaining.questions.map(({ question_id }) => question_id), [first.question_id]);
  assert.ok(remaining.questions[0].options[0].label, 'the remaining question is shown compactly');
  assert.match(remaining.next, /answer --text/);
  assert.deepEqual(JSON.parse(await readFile(pending, 'utf8')), [{ question_id: second.question_id, answer: '지도 전체 (c)' }]);

  // The rest as recommended: the stage launches again with both answers.
  const rest = native('answer', '--text', '나머지는 알아서', '--intent', 'recommended');
  assert.equal(rest.status, 0, rest.stderr);
  const launched = JSON.parse(rest.stdout);
  assert.equal(launched.status, 'launched');
  assert.equal(launched.answered, true);
  const stored = JSON.parse(await readFile(launched.answers_path, 'utf8'));
  assert.deepEqual(stored.sort((x, y) => x.question_id.localeCompare(y.question_id)), [{ question_id: first.question_id, answer: '핀 하나씩 (a)' }, { question_id: second.question_id, answer: '지도 전체 (c)' }]);

  // Nothing is waiting any more.
  const none = native('answer', '--text', '추천대로', '--intent', 'recommended');
  assert.notEqual(none.status, 0);
  assert.equal(JSON.parse(none.stderr).code, 'ANSWER_REFUSED');
  assert.match(none.stderr, /No stage is waiting|waiting for/);
  assert.notEqual(native('answer').status, 0, 'a reply is required');
});

test('a declared approve routes to the waiting gate whatever the wording; without a declaration nothing starts', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace } = flow;
  const answer = (text) => spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), 'answer', '--text', text, '--intent', 'approve'], { cwd: workspace, encoding: 'utf8' });
  // Nothing has completed, so no gate waits for an approval.
  assert.equal(JSON.parse(answer('승인합니다').stderr).code, 'ANSWER_REFUSED');
  // With bounded-context completed the reply is the approval: the existing check still refuses an unrecorded reply.
  const { resolveReplyTarget } = await import('../.harness/src/workflow/answer-text.mjs');
  const { writeFile, readFile: read } = await import('node:fs/promises');
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await read(statePath, 'utf8'));
  state.stages['bounded-context'] = { status: 'completed', code: 'OK', execution_id: 'bounded-context-1', result_ref: 'runtime/executions/bounded-context-1/result.json', result_session_directory: join(workspace, '.io') };
  await writeFile(statePath, JSON.stringify(state));
  const undeclared = resolveReplyTarget(workspace, '승인합니다');
  assert.equal(undeclared.args, undefined);
  assert.match(undeclared.clarification, /no intent was declared/);
  const target = resolveReplyTarget(workspace, '요구사항 승인합니다', { intent: 'approve' });
  assert.deepEqual(target.args, ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '요구사항 승인합니다']);
  assert.equal(target.approval, 'requirements');
  const paced = resolveReplyTarget(workspace, '승인하고 한단계만 진행해봐', { intent: 'approve' });
  assert.deepEqual(paced.args, ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '승인하고 한단계만 진행해봐']);
  state.stages['to-ticket'] = { status: 'completed', code: 'OK', execution_id: 'to-ticket-1', result_ref: 'x', result_session_directory: join(workspace, '.io') };
  state.stages['domain-model'] = { status: 'completed', code: 'OK', execution_id: 'domain-model-1', result_ref: 'x', result_session_directory: join(workspace, '.io') };
  await writeFile(statePath, JSON.stringify(state));
  assert.deepEqual(resolveReplyTarget(workspace, '발행 승인', { intent: 'approve' }).args.slice(0, 5), ['--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer']);
});

test('a revision reopens only the stage the orchestrator names; otherwise the revisable stages are returned', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'harness-revise-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, '.io/runtime/orchestrator'), { recursive: true });
  const run = (id) => ({ status: 'completed', code: 'OK', execution_id: `${id}-1` });
  const stages = Object.fromEntries(['subdomain-candidates', 'requirements-fix', 'bounded-context'].map((id) => [id, run(id)]));
  await writeFile(join(workspace, '.io/runtime/orchestrator/state.json'), JSON.stringify({ stages }));
  const target = resolveRevision(workspace, ' 승인합니다 ', 'requirements-fix');
  assert.deepEqual(target.args, ['--stage-id', 'requirements-fix', '--user-revision', 'true', '--feedback', '승인합니다']);
  assert.equal(target.approval, undefined);
  for (const stage of [null, 'domain-model', 'nope']) {
    const refused = resolveRevision(workspace, '문구를 바꿔 줘', stage);
    assert.equal(refused.args, undefined, String(stage));
    assert.deepEqual(refused.revisable_stages, ['subdomain-candidates', 'requirements-fix', 'bounded-context']);
    assert.match(refused.clarification, /requirements-fix/);
  }
  assert.equal(resolveApproval({ stages }, '네').approval, 'requirements');
  assert.match(resolveApproval({ stages: {} }, '승인합니다').error, /No stage is waiting/);
});
