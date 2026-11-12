import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

test('installed setup reuses current configuration and ignores old answer hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-setup-reuse-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: root });
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const config = 'agents:\n  codex:\n    high_performance_model: example\n    high_performance_reasoning_effort: high\n    implementation_model: example\n    implementation_reasoning_effort: medium\n    execution_model: example\n    execution_reasoning_effort: low\n    low_performance_model: example\n    low_performance_reasoning_effort: low\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\nbeads:\n  enabled: false\nobservability:\n  victorialogs:\n    local:\n      enabled: false\n';
    const configured = `${config}worktrees:\n  directory: ${JSON.stringify(join(root, '..', 'chosen worktrees'))}\n`;
    await writeFile(join(root, '.codex/harness.yaml'), configured);
    const budget = '{"schema_version":1,"context_window_tokens":1000,"max_plan_tokens":600,"handoff_reserve_tokens":200}\n';
    await writeFile(join(root, '.codex/context-budget.json'), budget);
    await writeFile(join(root, 'CONTEXT.md'), 'project context');
    await writeFile(join(root, 'CONTEXT-MAP.md'), 'project map');
    await mkdir(join(root, '.io/runtime/setup/4a11857b-60f0-4b0c-a3e6-3fea42eb45d2'), { recursive: true });
    const answers = join(root, '.io/runtime/setup/4a11857b-60f0-4b0c-a3e6-3fea42eb45d2/answers.json');
    await writeFile(answers, JSON.stringify({ configuration_hash: 'obsolete', answers: {} }));
    const setup = join(root, '.codex/scripts/harness-setup.mjs');
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [setup, '--root', root, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(run('--check'), { status: 'configured', violations: [] });
    const hook = join(root, '.codex/scripts/harness-orchestrator-hook.mjs');
    const observed = JSON.parse(execFileSync(process.execPath, [hook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: '4a11857b-60f0-4b0c-a3e6-3fea42eb45d2' }), encoding: 'utf8' }));
    assert.match(observed.hookSpecificOutput.additionalContext, /"setup_configuration":\{"status":"configured"/);
    assert.throws(() => run('--answers', join(root, '.io/runtime/setup/answers.json')), /unique setup session/);
    const first = run('--answers', answers);
    assert.equal(first.status, 'needs_input');
    assert.equal(first.pending.id, '기존 설정을 사용하거나 다시 설정할까요?#1');
    assert.deepEqual(first.pending.options.map(({ value }) => value), ['reuse', 'reconfigure']);
    assert.equal(Object.hasOwn(first, 'configuration_hash'), false);
    await writeFile(answers, JSON.stringify({ configuration_hash: 'obsolete', answers: { [first.pending.id]: 'reuse' } }));
    assert.equal(run('--answers', answers).status, 'configured');
    assert.equal(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), configured);
    assert.equal(await readFile(join(root, '.codex/context-budget.json'), 'utf8'), budget);
    assert.equal(await readFile(join(root, 'CONTEXT.md'), 'utf8'), 'project context');
    await writeFile(join(root, '.codex/harness.yaml'), config);
    const migrateWorktrees = run('--answers', answers);
    assert.equal(migrateWorktrees.pending.id, '워크트리 생성 위치 (절대 경로)#1');
    assert.equal(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), config);
    await writeFile(join(root, '.codex/harness.yaml'), configured);
    await writeFile(join(root, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":1000,"max_plan_tokens":600}\n');
    assert.equal(run('--check').status, 'setup_required');
    const partial = run('--answers', answers);
    assert.equal(partial.status, 'needs_input');
    assert.equal(partial.pending.id, 'checkpoint·인계용 예비 토큰#1');
    assert.equal(Object.hasOwn(partial, 'configuration_hash'), false);
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse', [partial.pending.id]: '200' } }));
    const confirmation = run('--answers', answers);
    assert.equal(confirmation.pending.id, '이 설정으로 계속할까요?#1');
    await writeFile(join(root, '.codex/harness.yaml'), `${configured}custom:\n  preserved: yes\n`);
    await writeFile(join(root, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":1100,"max_plan_tokens":600}\n');
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse', [partial.pending.id]: '200', [confirmation.pending.id]: 'y' } }));
    assert.equal(run('--answers', answers).status, 'configured');
    assert.match(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), /custom:\n  preserved: yes/);
    assert.equal(JSON.parse(await readFile(join(root, '.codex/context-budget.json'), 'utf8')).context_window_tokens, 1100);
    const fakeBin = join(root, '.io/fake-bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(fakeBin, 'codex'), '#!/usr/bin/env node\nconst rl=require("readline").createInterface({input:process.stdin});rl.on("line",s=>{const x=JSON.parse(s);if(x.id===1)console.log(JSON.stringify({id:1,result:{}}));if(x.id===2)console.log(JSON.stringify({id:2,result:{data:[{id:"example",displayName:"Example",supportedReasoningEfforts:[{reasoningEffort:"medium",description:"Medium"}]}]}}));});\n');
    await chmod(join(fakeBin, 'codex'), 0o755);
    const runWithModels = () => JSON.parse(execFileSync(process.execPath, [setup, '--root', root, '--answers', answers], { cwd: root, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reconfigure' } }));
    const provider = runWithModels();
    assert.equal(provider.pending.id, '워크트리 생성 위치 (절대 경로)#1');
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reconfigure', [provider.pending.id]: join(root, '..', 'chosen worktrees'), '실행 provider 선택#1': 'codex' } }));
    const reconfigure = runWithModels();
    assert.equal(reconfigure.pending.id, '복잡한 설계·최종 검토 모델 모델 선택#1');
    assert.equal(reconfigure.pending.current, 'example');
    await writeFile(join(root, '.codex/harness.yaml'), configured.replace('    execution_model: example\n', ''));
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse' } }));
    const missingModel = runWithModels();
    assert.equal(missingModel.pending.id, '서버·E2E 실행과 polling 모델 모델 선택#1');
    await writeFile(join(root, '.codex/harness.yaml'), configured.replace('  execution_reasoning_effort: low', '  execution_reasoning_effort: invalid'));
    const invalidEffort = runWithModels();
    assert.equal(invalidEffort.pending.id, '서버·E2E 실행과 polling 모델 추론 강도 선택#1');
    assert.equal(run('--check').status, 'setup_required');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /CONTEXT\.md/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\//);
    execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-setup.mjs'], { cwd: root });
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Native setup asks everything it can in one batch; `pending` stays the first question for callers that ask one at a time.
const SETUP_ID = '4a11857b-60f0-4b0c-a3e6-3fea42eb45d2';
const MODELS = [
  ['복잡한 설계·최종 검토 모델', 'high_performance'], ['일반 구현 모델', 'implementation'], ['서버·E2E 실행과 polling 모델', 'execution'], ['문서·제한된 조사 모델', 'low_performance'],
];

async function freshProject() {
  const root = await mkdtemp(join(tmpdir(), 'harness-setup-batch-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const bin = join(root, '.io/fake-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  // Two models: the first offers medium and xhigh, the second only low.
  await writeFile(join(bin, 'codex'), '#!/usr/bin/env node\nconst rl=require("readline").createInterface({input:process.stdin});rl.on("line",s=>{const x=JSON.parse(s);if(x.id===1)console.log(JSON.stringify({id:1,result:{}}));if(x.id===2)console.log(JSON.stringify({id:2,result:{data:[{id:"example-a",displayName:"A",supportedReasoningEfforts:[{reasoningEffort:"medium",description:"Medium"},{reasoningEffort:"xhigh",description:"Extra"}]},{id:"example-b",displayName:"B",supportedReasoningEfforts:[{reasoningEffort:"low",description:"Low"}]}]}}));});\n');
  await chmod(join(bin, 'codex'), 0o755);
  const directory = join(root, '.io/runtime/setup', SETUP_ID);
  await mkdir(directory, { recursive: true });
  const answers = join(directory, 'answers.json');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const run = async (map) => {
    await writeFile(answers, JSON.stringify({ answers: map }));
    return JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-setup.mjs'), '--root', root, '--answers', answers], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  return { root, sourceRoot, run, git };
}

const exists = (path) => readFile(path).then(() => true, () => false);
const firstOption = (question) => question.options.some(({ value }) => value === question.current) ? question.current : question.options[0].value;
// What a caller returns for a batch: the offered value for each select question, and the given text for the rest.
const answerBatch = (questions, choose = {}) => Object.fromEntries(questions.map((question) => {
  const key = Object.keys(choose).find((prefix) => question.prompt.startsWith(prefix));
  return [question.id, key ? choose[key] : question.options ? firstOption(question) : question.current];
}));
const BATCH_CHOICES = {
  '복잡한 설계·최종 검토 모델 모델': 'example-a', '복잡한 설계·최종 검토 모델 추론': 'xhigh', '일반 구현 모델 모델': 'example-a', '일반 구현 모델 추론': 'medium',
  '서버·E2E 실행과 polling 모델 모델': 'example-a', '서버·E2E 실행과 polling 모델 추론': 'medium', '문서·제한된 조사 모델 모델': 'example-b', '문서·제한된 조사 모델 추론': 'low',
  '선택 모델 공통 context 한도': '1000', 'plan 하나의 최대 예상 토큰': '600', 'checkpoint·인계용 예비 토큰': '200',
  'Tracker 선택': 'local-markdown', '로컬 계획 디렉터리': 'docs/plans', 'Beads를': 'n', '로컬 관측성': 'n', '이 설정으로 계속할까요?': 'y',
};

test('setup returns every question of a fresh project in one batch, marks the dependent ones and writes nothing', async () => {
  const { root, run, git } = await freshProject();
  try {
    const first = await run({});
    assert.equal(first.status, 'needs_input');
    assert.deepEqual(first.pending, first.questions[0]);
    const ids = first.questions.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length);
    const at = (prefix) => first.questions.findIndex((question) => question.prompt.startsWith(prefix));
    const order = ['실행 provider 선택', '복잡한 설계·최종 검토 모델 모델', '복잡한 설계·최종 검토 모델 추론', '일반 구현 모델 모델', '서버·E2E 실행과 polling 모델 모델', '문서·제한된 조사 모델 추론',
      '선택 모델 공통 context 한도', 'plan 하나의 최대 예상 토큰', 'checkpoint·인계용 예비 토큰', 'Tracker 선택', '로컬 계획 디렉터리', 'Beads를', '로컬 관측성', 'VictoriaLogs localhost port', '이 설정으로 계속할까요?'];
    assert.deepEqual(order.map(at), order.map(at).toSorted((left, right) => left - right), 'questions keep the order setup would ask them in');
    assert.ok(order.every((prefix) => at(prefix) >= 0), 'every question of the project is in the batch');
    assert.equal(at('이 설정으로 계속할까요?'), first.questions.length - 1);
    const byPrompt = (prefix) => first.questions[at(prefix)];
    // Each question keeps its prompt, type, options and current value.
    assert.deepEqual(byPrompt('실행 provider 선택').options.map(({ value }) => value), ['codex', 'claude-code']);
    assert.deepEqual(byPrompt('복잡한 설계·최종 검토 모델 모델').options.map(({ value }) => value), ['example-a', 'example-b']);
    assert.equal(byPrompt('선택 모델 공통 context 한도').type, 'text');
    assert.equal(byPrompt('로컬 계획 디렉터리').current, 'docs/plans');
    // The dependent ones say what they follow from; the independent ones carry no mark.
    const provider = byPrompt('실행 provider 선택').id, tracker = byPrompt('Tracker 선택').id, observability = byPrompt('로컬 관측성').id;
    for (const [title] of MODELS) {
      const model = byPrompt(`${title} 모델`), effort = byPrompt(`${title} 추론`);
      assert.deepEqual(model.depends_on, [provider]);
      assert.deepEqual(effort.depends_on, [provider, model.id]);
    }
    assert.deepEqual(byPrompt('로컬 계획 디렉터리').depends_on, [tracker]);
    assert.deepEqual(byPrompt('VictoriaLogs localhost port').depends_on, [observability]);
    for (const prefix of ['실행 provider 선택', 'Tracker 선택', 'Beads를', '로컬 관측성', '선택 모델 공통 context 한도']) assert.equal(Object.hasOwn(byPrompt(prefix), 'depends_on'), false, prefix);
    assert.deepEqual(first.questions.at(-1).depends_on, ids.slice(0, -1), 'the confirmation covers every answer in the batch');
    // Nothing was written while answers were missing.
    for (const path of ['.codex/harness.yaml', '.codex/context-budget.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/agents/EXEC.md']) assert.equal(await exists(join(root, path)), false, path);
    assert.doesNotMatch(git('status', '--short', '--untracked-files=all'), /CONTEXT\.md|docs\//);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('answering the batch applies the configuration in one more run and keeps Harness files out of git status', async () => {
  const { root, run, git } = await freshProject();
  try {
    const first = await run({});
    const selected = join(root, '..', 'custom worktree location');
    const answered = await run(answerBatch(first.questions, { ...BATCH_CHOICES, '워크트리 생성 위치': selected }));
    assert.equal(answered.status, 'configured');
    const config = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    assert.ok(config.includes(`directory: ${JSON.stringify(selected)}`));
    assert.match(config, /provider: "codex"/);
    assert.match(config, /high_performance_model: "example-a"/);
    assert.match(config, /high_performance_reasoning_effort: "xhigh"/);
    assert.match(config, /low_performance_model: "example-b"/);
    assert.match(config, /low_performance_reasoning_effort: "low"/);
    assert.match(config, /mode: "local-markdown"/);
    assert.match(config, /enabled: false/);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.codex/context-budget.json'), 'utf8')), { schema_version: 1, context_window_tokens: 1000, max_plan_tokens: 600, handoff_reserve_tokens: 200 });
    assert.equal(await exists(join(root, 'CONTEXT.md')), true);
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /CONTEXT\.md/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\//);
    git('check-ignore', '-v', '.codex/harness.yaml');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup rejects a relative worktree location', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    await assert.rejects(run(answerBatch(first.questions, { ...BATCH_CHOICES, '워크트리 생성 위치': 'relative/path' })), /절대 경로/);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('changing the provider answer asks again only the model and effort questions that no longer fit, plus the confirmation', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    const batchAnswers = answerBatch(first.questions, BATCH_CHOICES);
    const provider = first.questions.find(({ prompt }) => prompt === '실행 provider 선택');
    // The same answers, except that the user picked the other provider.
    const followUp = await run({ ...batchAnswers, [provider.id]: 'claude-code' });
    assert.equal(followUp.status, 'needs_input');
    const asked = followUp.questions.map(({ prompt }) => prompt);
    assert.deepEqual(asked, [
      '복잡한 설계·최종 검토 모델 모델 선택', '복잡한 설계·최종 검토 모델 추론 강도 선택', '일반 구현 모델 모델 선택', '서버·E2E 실행과 polling 모델 모델 선택', '문서·제한된 조사 모델 모델 선택', '이 설정으로 계속할까요?',
    ]);
    // The other efforts (medium, low) are valid for a Claude Code model too, so they stay answered.
    for (const question of followUp.questions.filter(({ prompt }) => prompt.endsWith('모델 선택'))) {
      assert.deepEqual(question.options.map(({ value }) => value), ['opus', 'sonnet', 'haiku']);
      assert.equal(question.previous_answer, batchAnswers[question.id]);
      assert.deepEqual(question.depends_on, undefined, 'the provider is answered now, so nothing in this batch is derived from a guess');
    }
    const effort = followUp.questions.find(({ prompt }) => prompt.endsWith('추론 강도 선택'));
    assert.equal(effort.previous_answer, 'xhigh');
    assert.deepEqual(effort.options.map(({ value }) => value), ['low', 'medium', 'high']);
    assert.equal(followUp.questions.at(-1).previous_answer, 'y');
    for (const prompt of ['선택 모델 공통 context 한도', 'Tracker 선택', 'Beads를']) assert.equal(asked.some((item) => item.startsWith(prompt)), false, `${prompt} is not asked again`);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);

    const resolved = await run({ ...batchAnswers, [provider.id]: 'claude-code', ...answerBatch(followUp.questions, { '복잡한 설계·최종 검토 모델 모델': 'opus', '복잡한 설계·최종 검토 모델 추론': 'high', '일반 구현 모델 모델': 'sonnet', '서버·E2E 실행과 polling 모델 모델': 'sonnet', '문서·제한된 조사 모델 모델': 'haiku', '이 설정으로 계속할까요?': 'y' }) });
    assert.equal(resolved.status, 'configured');
    const config = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    assert.match(config, /provider: "claude-code"/);
    assert.match(config, /claude-code:\s+high_performance_model: "opus"\s+high_performance_reasoning_effort: "high"/);
    assert.match(config, /implementation_reasoning_effort: "medium"/);
    assert.match(config, /low_performance_model: "haiku"/);
    assert.doesNotMatch(config, /example-a/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an answer that cannot fit whatever else is chosen is an error, not a gap to ask again', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    const tracker = first.questions.find(({ prompt }) => prompt === 'Tracker 선택');
    await assert.rejects(run({ ...answerBatch(first.questions, BATCH_CHOICES), [tracker.id]: 'bogus' }), /Invalid or stale selection for Tracker 선택#1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a question that appears only after an answer is asked in the next batch, and only that one', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    const tracker = first.questions.find(({ prompt }) => prompt === 'Tracker 선택');
    // GitHub questions cannot be derived while the provisional tracker is local-markdown, so they come once github is chosen.
    const github = await run({ ...answerBatch(first.questions, BATCH_CHOICES), [tracker.id]: 'github' });
    assert.equal(github.status, 'needs_input');
    assert.deepEqual(github.questions.map(({ prompt }) => prompt), ['GitHub repository (owner/repo)', '이 설정으로 계속할까요?']);
    assert.deepEqual(github.questions[0].depends_on, undefined);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
