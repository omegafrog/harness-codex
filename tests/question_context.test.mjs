import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQuestionContext, questionContextProblems } from '../.harness/src/workflow/questions.mjs';
import { validateOutputFormat } from '../.harness/src/workflow/output-schema.mjs';
import { STAGE_CONTRACT } from '../.harness/src/installer/stage-contract.mjs';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const REQUEST = '게시글 삭제 기능을 추가해줘';

// The unclear question of the map run: it names a business unit but shows nothing about what changes on screen.
const owned = {
  title: '[BIZ-02] 본인 데이터의 공개 범위는 어떤 단위로 정하나요?',
  context: { settled_rules: ['지도에는 소유자가 올린 핀이 표시된다', '공개 범위는 소유자가 정한다'], why_now: '공개 범위의 단위가 있어야 소유자 데이터 모델을 확정할 수 있다' },
  options: [
    { id: 'per_item', label: '핀 하나씩', consequence: '핀마다 공개 범위가 있다', effect: '소유자는 핀마다 공개 범위를 따로 바꾼다', example: '같은 소유자의 핀 두 개 중 하나만 공개할 수 있다', evidence: [] },
    { id: 'per_owner', label: '소유자 묶음', consequence: '소유자 전체에 하나의 공개 범위가 있다', effect: '소유자가 공개 범위를 한 번 바꾸면 모든 핀에 적용된다', example: '같은 소유자의 핀 두 개는 항상 같은 공개 범위를 갖는다', evidence: [] },
  ],
  recommended_option_id: 'per_item', rationale: '요구사항은 핀 단위 등록만 말한다', decision_kind: null,
};
const legacy = (question) => { const { context, ...rest } = question; return { ...rest, options: question.options.map(({ effect, example, ...option }) => option) }; };
const withOptions = (question, change) => ({ ...question, options: question.options.map((option, index) => ({ ...option, ...change(option, index) })) });

test('a question needs its settled rules, why now, and per option an effect and a different example', () => {
  assert.deepEqual(questionContextProblems(owned), []);
  assertQuestionContext([owned, owned]);

  const problems = (question) => questionContextProblems(question).join('\n');
  assert.match(problems(legacy(owned)), /context \{settled_rules, why_now\} is missing/);
  assert.match(problems(legacy(owned)), /option per_item needs effect/);
  assert.match(problems(legacy(owned)), /option per_owner needs example/);
  assert.match(problems({ ...owned, context: { settled_rules: [], why_now: '이유' } }), /settled_rules must list/);
  assert.match(problems({ ...owned, context: { settled_rules: ['규칙', '  '], why_now: '이유' } }), /settled_rules must list/);
  assert.match(problems({ ...owned, context: { settled_rules: '규칙', why_now: '이유' } }), /settled_rules must list/);
  assert.match(problems({ ...owned, context: { settled_rules: ['규칙'], why_now: '   ' } }), /why_now must say/);
  assert.match(problems({ ...owned, context: [] }), /context .* is missing/);
  // One copied example or effect is not a worked comparison.
  assert.match(problems(withOptions(owned, () => ({ example: '같은 소유자의 핀 두 개' }))), /option per_owner repeats the example of option per_item/);
  assert.match(problems(withOptions(owned, () => ({ effect: '화면이 바뀐다' }))), /option per_owner repeats the effect of option per_item/);
  assert.match(problems(withOptions(owned, (option) => ({ example: option.effect }))), /gives the same text as effect and example/);
  assert.match(problems(withOptions(owned, (option, index) => (index ? { effect: ' ' } : {}))), /option per_owner needs effect/);

  // Every problem of every question is named once, with its 1-based question number.
  assert.throws(() => assertQuestionContext([owned, legacy(owned), legacy(owned)]), (error) => /question 2: context/.test(error.message) && /question 3: option per_owner needs example/.test(error.message) && !/question 1:/.test(error.message) && /never new requirements|never recorded|illustrate/.test(error.message));
  assert.doesNotThrow(() => assertQuestionContext([]));
  assert.doesNotThrow(() => assertQuestionContext(undefined));
});

test('an option is not an edit request or an answer-text outcome, and ordinary rules still pass', () => {
  const change = (patch) => withOptions(owned, (option, index) => (index ? patch : {}));
  assert.match(questionContextProblems(change({ label: '수정이 필요함', effect: '답변 문구로 초안을 바꿉니다' })).join(), /edit the draft[\s\S]*direct input/);
  assert.deepEqual(questionContextProblems(change({ label: '수정 권한은 본인만 갖는다', effect: '변경 이력을 보여 준다' })), []);
  assert.doesNotThrow(() => assertQuestionContext([legacy(owned)], { schema: { properties: { result: { properties: { questions: { items: { properties: {} } } } } } } }));
});

test('a question is short: one line for why now, each effect and each example, and at most three settled rules', () => {
  const long = '가'.repeat(161);
  const problems = (question) => questionContextProblems(question).join('\n');
  assert.deepEqual(questionContextProblems(withOptions(owned, (option) => ({ effect: `${option.effect}`.padEnd(160, '다'), example: `${option.example}`.padEnd(160, '라') }))), []);
  assert.match(problems({ ...owned, context: { ...owned.context, why_now: long } }), /why_now must be one line/);
  assert.match(problems({ ...owned, context: { ...owned.context, settled_rules: ['a', 'b', 'c', 'd'] } }), /settled_rules must list at most 3/);
  assert.match(problems({ ...owned, context: { ...owned.context, settled_rules: [long] } }), /settled_rules must list at most 3/);
  assert.match(problems(withOptions(owned, (option, index) => (index ? {} : { effect: long }))), /option per_item effect must be one line/);
  assert.match(problems(withOptions(owned, (option, index) => (index ? {} : { example: long }))), /option per_item example must be one line/);
});

test('no question kind is exempt from the context, the effect and the example', () => {
  const technology = { ...owned, decision_kind: 'technology', options: owned.options.map((option) => ({ ...option, evidence: [{ criterion: '운영', result: 'met', claim_id: 'claim-1', source_title: '문서', url: 'https://example.com/docs', checked_at: '2026-11-23' }] })) };
  assert.deepEqual(questionContextProblems(technology), []);
  assert.match(questionContextProblems(legacy(technology)).join('\n'), /context/);
  const visual = { ...owned, decision_kind: 'visual_direction', options: owned.options.map((option) => ({ ...option, previews: [{ path: 'runtime/executions/x/style-options/a/desktop.png', viewport: 'desktop', caption: '데스크톱' }, { path: 'runtime/executions/x/style-options/a/mobile.png', viewport: 'mobile', caption: '모바일' }] })) };
  assert.deepEqual(questionContextProblems(visual), []);
  assert.match(questionContextProblems(legacy(visual)).join('\n'), /option per_item needs example/, 'a text example also serves a question UI that cannot show the previews');
});

test('an execution whose output schema predates the rule is not held to it, and every other submission is', () => {
  const declared = { properties: { result: { properties: { questions: { items: { properties: { context: {} } } } } } } };
  const predating = { properties: { result: { properties: { questions: { items: { properties: { title: {} } } } } } } };
  assert.doesNotThrow(() => assertQuestionContext([legacy(owned)], { schema: predating }));
  assert.throws(() => assertQuestionContext([legacy(owned)], { schema: declared }), /Questions must let the user decide/);
  assert.throws(() => assertQuestionContext([legacy(owned)], { schema: null }), /Questions must let the user decide/);
  assert.throws(() => assertQuestionContext([legacy(owned)]), /Questions must let the user decide/);
  assert.doesNotThrow(() => assertQuestionContext([owned], { schema: declared }));
});

test('the stored question schemas accept questions stored before the rule and check the new fields when present', async () => {
  const schema = await readJson('.harness/schemas/question.schema.json');
  const stored = { ...legacy(owned), question_id: 'ask:1' };
  const check = (question) => validateOutputFormat(question, schema);
  assert.equal(schema.required.includes('context'), false);
  assert.equal(schema.properties.options.items.required.some((key) => ['effect', 'example'].includes(key)), false);
  assert.deepEqual(check(stored).errors, [], 'a stored question without context, effect or example stays valid');
  const { decision_kind, ...unkinded } = stored;
  assert.deepEqual(check(unkinded).errors, [], 'so does one without decision_kind');
  assert.deepEqual(check({ ...owned, question_id: 'ask:2' }).errors, []);
  assert.ok(check({ ...stored, context: { settled_rules: [], why_now: '이유' } }).errors.some(({ path }) => path === '$.context.settled_rules'));
  assert.ok(check({ ...stored, context: { settled_rules: ['규칙'] } }).errors.some(({ path }) => path === '$.context.why_now'));
  assert.ok(check({ ...stored, context: { settled_rules: ['규칙'], why_now: '이유', extra: 1 } }).errors.some(({ path }) => path === '$.context.extra'));
  assert.ok(check({ ...stored, options: stored.options.map((option) => ({ ...option, example: 3 })) }).errors.some(({ path }) => path === '$.options[0].example'));
  // The flow result schemas carry the same optional fields, so a worker can write them and a stored result stays valid.
  for (const name of ['common', 'plan-review', 'spec-review']) {
    const item = (await readJson(`.harness/schemas/flows/${name}.schema.json`)).properties.questions.items;
    assert.equal(item.required.includes('context'), false, name);
    assert.deepEqual([item.properties.context.required, item.properties.context.properties.settled_rules.minItems], [['settled_rules', 'why_now'], 1], name);
    assert.deepEqual(['effect', 'example'].map((key) => item.properties.options.items.properties[key].type), ['string', 'string'], name);
  }
});

test('the installed stage output schema requires the context, effect and example, and finish enforces them', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const stage = 'stakeholder-analysis';
  const analysis = flow.specPath('stakeholder-analysis.md');
  const files = { [analysis]: stakeholderAnalysisDocument(REQUEST) };
  const waiting = { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', files };

  const begun = await flow.beginStage(stage);
  const schema = JSON.parse(await readFile(begun.started.schema_path, 'utf8'));
  const question = schema.properties.result.properties.questions.items;
  assert.ok(question.required.includes('context'));
  assert.ok(question.properties.options.items.required.includes('effect') && question.properties.options.items.required.includes('example'));
  assert.deepEqual(question.properties.context.required, ['settled_rules', 'why_now']);

  const refused = async (questions) => {
    await flow.submitStage(begun, { ...waiting, questions });
    const result = flow.finishStage(begun);
    assert.notEqual(result.status, 0);
    return result;
  };
  // A question as workers wrote it before: the shape error names every missing key.
  const bare = await refused([{ question_id: 'q', ...legacy(owned) }]);
  const format = JSON.parse(bare.stdout);
  assert.equal(format.status, 'format_error');
  const missing = format.errors.filter(({ missing: absent }) => absent).map(({ path }) => path);
  assert.ok(['$.result.questions[0].context', '$.result.questions[0].options[0].effect', '$.result.questions[0].options[1].example'].every((path) => missing.includes(path)), missing.join(', '));
  // A complete shape whose options copy one example is rejected by the runner with what to change.
  const copied = await refused([{ question_id: 'q', ...withOptions(owned, () => ({ example: '핀 두 개가 있다' })) }]);
  assert.match(copied.stderr + copied.stdout, /option per_owner repeats the example of option per_item/);
  // A blank rule is shape-valid text but not a settled rule.
  const blank = await refused([{ question_id: 'q', ...owned, context: { settled_rules: ['  '], why_now: '이유' } }]);
  assert.match(blank.stderr + blank.stdout, /settled_rules must list/);

  await flow.submitStage(begun, { ...waiting, questions: [{ question_id: 'q', ...owned }] });
  const finished = flow.finishStage(begun);
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  // The default output carries the question the user decides on (title, context lines, option label and one-line effect,
  // recommended flag), so the orchestrator opens no file; the canonical result still holds the whole question.
  const compact = JSON.parse(finished.stdout);
  const [shown] = compact.result.questions;
  assert.equal(shown.title, owned.title);
  assert.deepEqual(Object.keys(shown).sort(), ['context', 'options', 'question_id', 'reason', 'title']);
  assert.ok(shown.context.length <= 2 && shown.context.every((line) => line.length <= 160));
  assert.deepEqual(shown.options.map(({ id, label, effect }) => ({ id, label, effect })), owned.options.map(({ id, label, effect }) => ({ id, label, effect })));
  assert.deepEqual(shown.options.filter(({ recommended }) => recommended).map(({ id }) => id), [owned.recommended_option_id]);
  assert.equal(compact.result.questions_path, undefined, 'the orchestrator is not sent to a result file');
  assert.match(compact.next, /without opening any file/);
  const stored = JSON.parse(await readFile(join(flow.workspace, '.io', compact.result_ref), 'utf8'));
  assert.deepEqual(stored.questions[0].context, owned.context);
  assert.deepEqual(stored.questions[0].options.map(({ example }) => example), owned.options.map(({ example }) => example));
  assert.deepEqual(stored.questions[0].options.map(({ effect }) => effect), owned.options.map(({ effect }) => effect));

  // The answer resumes the stage; the new input lists the prior input, which resolves from its base and not from a sibling path.
  const answered = flow.invoke(flow.workspace, 'harness-native-stage.mjs', ['launch', '--stage-id', stage, '--verbose', '--answer', JSON.stringify([{ question_id: stored.questions[0].question_id, answer: 'per_item' }])]);
  assert.equal(answered.answered, true);
  const { input } = answered;
  const priorInput = input.input_refs.find(({ kind }) => kind === 'previous_execution_input');
  assert.equal(priorInput.base, 'session');
  assert.ok(existsSync(join(flow.workspace, '.io', priorInput.path)), 'the listed prior input exists under the session directory');
  assert.match(input.context.previous_result_ref, /^runtime\/executions\//, 'result refs are relative to the session directory');
  assert.ok(existsSync(join(flow.workspace, '.io', input.context.previous_result_ref)));
});

test('an execution started before the rule keeps its schema, accepts its old questions, and its stored questions resume', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const stage = 'stakeholder-analysis';
  const analysis = flow.specPath('stakeholder-analysis.md');
  const begun = await flow.beginStage(stage);
  // The output schema this worker was given is the one from before the update.
  const schema = JSON.parse(await readFile(begun.started.schema_path, 'utf8'));
  const question = schema.properties.result.properties.questions.items;
  delete question.properties.context;
  question.required = question.required.filter((key) => key !== 'context');
  for (const key of ['effect', 'example']) { delete question.properties.options.items.properties[key]; question.properties.options.items.required = question.properties.options.items.required.filter((name) => name !== key); }
  await writeFile(begun.started.schema_path, JSON.stringify(schema, null, 2) + '\n');

  await flow.submitStage(begun, { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', files: { [analysis]: stakeholderAnalysisDocument(REQUEST) }, questions: [{ question_id: 'q', ...legacy(owned) }] });
  const finished = flow.finishStage(begun);
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  const [recorded] = JSON.parse(finished.stdout).result.questions;
  assert.equal(recorded.context, undefined);
  assert.deepEqual(recorded.options.map(({ id, label }) => ({ id, label })), legacy(owned).options.map(({ id, label }) => ({ id, label })), 'a stored question without effect shows its option labels');
  const stored = JSON.parse(await readFile(join(flow.workspace, '.io', JSON.parse(finished.stdout).result_ref), 'utf8'));
  assert.equal(stored.questions[0].options[0].example, undefined);

  // The stored result is read again when the answer resumes the stage.
  const answered = flow.invoke(flow.workspace, 'harness-native-stage.mjs', ['launch', '--stage-id', stage, '--verbose', '--answer', JSON.stringify([{ question_id: recorded.question_id, answer: 'per_owner' }])]);
  assert.equal(answered.answered, true);
  assert.ok(answered.input.input_refs.some(({ kind }) => kind === 'previous_execution_result'), 'the old question result is a listed input of the resumed stage');
});

test('installed stage profiles state the question rule and the read-through-refs rule', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  for (const profile of ['.codex/agents/workflow_stage.toml', '.claude/agents/workflow_stage.md', '.codex/agents/tactical_designer.toml']) {
    const text = await readFile(join(flow.primary, profile), 'utf8');
    assert.ok(text.includes(STAGE_CONTRACT), profile);
    // Questions: settled rules and why now, then per option the effect and an example applied to the same situation.
    assert.match(text, /`context\.settled_rules` lists at most 3 already-settled business rules/, profile);
    assert.match(text, /`context\.why_now` is one line/, profile);
    assert.match(text, /`effect` \(what changes on screen or in behavior\)/, profile);
    assert.match(text, /`example` \(the same concrete situation applied to that option/, profile);
    assert.match(text, /An example illustrates and is never a requirement/, profile);
    // Prior inputs, results and answers come only from the refs the input lists.
    assert.match(text, /only through a ref the input gives, resolved by its `base`: an `input_refs` entry/, profile);
    assert.match(text, /`context\.upstream`/, profile);
    assert.match(text, /`context\.previous_result_ref`/, profile);
    assert.match(text, /Never derive a sibling path \(for example a prior `input\.json` beside a result\)/, profile);
    assert.match(text, /never search `\.io` or the session directory for earlier results or answers/, profile);
  }
  const stageGuide = (name) => readFile(join(flow.primary, '.harness/internal-skills', name, 'GUIDE.md'), 'utf8');
  const grilling = await stageGuide('grilling');
  assert.match(grilling, /^## Ask questions the user can answer$/m);
  assert.match(grilling, /Give every question its context and every option a worked example/);
  assert.match(grilling, /two pins of one owner on a map/);
  // The GUIDEs that write questions point at that one owner instead of restating it.
  for (const name of ['event-storming', 'stakeholder-analysis', 'subdomain-candidates', 'subdomain-classification', 'requirements-fix', 'bounded-context', 'grill-with-docs', 'technology-selection', 'tactical-ui', 'contract-review', 'sync-contracts', 'plan-review']) {
    assert.match(await stageGuide(name), /\]\(\.\.\/grilling\/GUIDE\.md#ask-questions-the-user-can-answer\)/, name);
  }
  assert.match(await stageGuide('frontend-design'), /`effect`\(화면에서 달라지는 점\)와 `example`/);
  // The sibling-path rule has one owner, the stage contract; the event-storming copies of it are gone.
  const eventStorming = await stageGuide('event-storming');
  assert.doesNotMatch(eventStorming, /beside a result|Result 경로와 같은/);
  assert.match(eventStorming, /`input_refs` lists it/);

  // The orchestrator relays the context and the per-option examples and waits for a real answer, for both providers.
  for (const provider of ['.codex', '.claude']) {
    const input = await readFile(join(flow.primary, provider, 'skills/orchestrator/references/input.md'), 'utf8');
    assert.match(input, /선택지별 `label`·한 줄 `effect`·`recommended`/, provider);
    assert.match(input, /파일을 열지 않고 `title`과 `label`은 원문 그대로/, provider);
    assert.match(input, /설명 요청은 답변이 아니므로 설명한 뒤 같은 맥락과 선택지별 예시를 유지해 다시 묻고, 실제 답을 받기 전에는 stage를 재개하지 않는다/, provider);
    const coordination = await readFile(join(flow.primary, provider, 'skills/orchestrator/references/coordination.md'), 'utf8');
    assert.match(coordination, /`title`·`context`와 선택지별 `label`·`effect`·`recommended`를 모두 질문 도구에 담는다/, provider);
    assert.doesNotMatch(coordination, /`title`과 문자열 options만 전달/, provider);
    assert.match(await readFile(join(flow.primary, provider, 'skills/orchestrator/SKILL.md'), 'utf8'), /선택지별 label·effect·example, 추천 표시와 `reason`\)를 파일 없이 한국어로 보여 주고 기다린다/, provider);
  }
  assert.ok(withDecisionContext({ options: [{ id: 'a', label: 'A', consequence: 'a' }, { id: 'b', label: 'B', consequence: 'b' }] }).options.every(({ effect, example }) => effect && example), 'the shared fixture helper completes a bare question');
});
