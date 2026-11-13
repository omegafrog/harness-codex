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
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse' } }));
    const migrateWorktrees = run('--answers', answers);
    assert.equal(migrateWorktrees.pending.id, '워크트리 생성 위치 (절대 경로)#1');
    assert.equal(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), config);
    await writeFile(join(root, '.codex/harness.yaml'), configured);
    await writeFile(join(root, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":1000,"max_plan_tokens":600}\n');
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse' } }));
    assert.equal(run('--check').status, 'setup_required');
    const partial = run('--answers', answers);
    assert.equal(partial.status, 'needs_input');
    assert.equal(partial.pending.id, '이 설정으로 계속할까요?#1');
    assert.doesNotMatch(JSON.stringify(partial.questions), /context 한도|최대 예상 토큰|인계용 예비 토큰/);
    assert.equal(Object.hasOwn(partial, 'configuration_hash'), false);
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse', [partial.pending.id]: 'y' } }));
    const confirmation = run('--answers', answers);
    assert.equal(confirmation.status, 'configured');
    assert.equal(JSON.parse(await readFile(join(root, '.codex/context-budget.json'), 'utf8')).handoff_reserve_tokens, 200);
    await writeFile(join(root, '.codex/harness.yaml'), `${configured}custom:\n  preserved: yes\n`);
    await writeFile(join(root, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":1100,"max_plan_tokens":600}\n');
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse', [partial.pending.id]: 'y' } }));
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
    let batch = runWithModels();
    let setupAnswers = { [first.pending.id]: 'reconfigure' };
    const selectedWorktrees = join(root, '..', 'chosen worktrees');
    for (let round = 0; round < 6 && !batch.questions.some(({ prompt }) => prompt.startsWith('복잡한 설계·최종 검토 모델 모델 선택')); round += 1) {
      setupAnswers = { ...setupAnswers, ...answerBatch(batch.questions, { ...BATCH_CHOICES, '워크트리 생성 위치': selectedWorktrees, '실행 provider 선택': 'codex' }) };
      await writeFile(answers, JSON.stringify({ answers: setupAnswers }));
      batch = runWithModels();
    }
    const reconfigure = batch;
    assert.equal(reconfigure.pending.id, '복잡한 설계·최종 검토 모델 모델 선택#1');
    assert.equal(reconfigure.pending.current, 'example');
    await writeFile(join(root, '.codex/harness.yaml'), configured.replace('    execution_model: example\n', ''));
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse' } }));
    const missingModel = runWithModels();
    assert.equal(missingModel.pending.id, '서버·E2E 실행과 polling 모델 모델 선택#1');
    await writeFile(join(root, '.codex/harness.yaml'), configured.replace('  execution_reasoning_effort: low', '  execution_reasoning_effort: invalid'));
    await writeFile(answers, JSON.stringify({ answers: { [first.pending.id]: 'reuse' } }));
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

// Native setup returns only currently resolvable questions; `pending` is the first question for callers that ask one at a time.
const SETUP_ID = '4a11857b-60f0-4b0c-a3e6-3fea42eb45d2';
const MODELS = [
  ['복잡한 설계·최종 검토 모델', 'high_performance'], ['일반 구현 모델', 'implementation'], ['서버·E2E 실행과 polling 모델', 'execution'], ['문서·제한된 조사 모델', 'low_performance'],
];

async function freshProject({ linked = false } = {}) {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'harness-setup-batch-'));
  const primary = linked ? join(workspaceDir, 'project') : workspaceDir;
  const root = linked ? join(workspaceDir, 'linked worktree') : workspaceDir;
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  if (linked) await mkdir(primary);
  execFileSync('git', ['init', '-q', '-b', 'main', primary]);
  if (linked) {
    execFileSync('git', ['-C', primary, '-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'feature/setup', root]);
  }
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
  const command = (...args) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-setup.mjs'), '--root', root, '--answers', answers, ...args], { cwd: root, env: { ...process.env, CODEX_THREAD_ID: 'setup-test-session', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const run = async (map) => {
    await writeFile(answers, JSON.stringify({ answers: map }));
    return command();
  };
  return { root, primary, cleanupRoot: linked ? workspaceDir : root, sourceRoot, run, git, answers, bin, command };
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
  'Tracker 선택': 'local-markdown', '로컬 계획 디렉터리': 'docs/plans', 'Beads를': 'n', '로컬 관측성': 'n', '이 설정으로 계속할까요?': 'y',
};

test('setup asks only questions whose conditions are known and carries runtime context without budget questions', async () => {
  const { root, run, git } = await freshProject();
  try {
    const first = await run({});
    assert.equal(first.status, 'needs_input');
    assert.deepEqual(first.pending, first.questions[0]);
    const prompts = first.questions.map(({ prompt }) => prompt);
    assert.ok(prompts.some((prompt) => prompt.startsWith('실행 provider 선택')));
    assert.ok(prompts.some((prompt) => prompt.startsWith('Tracker 선택')));
    assert.ok(prompts.some((prompt) => prompt.startsWith('로컬 관측성')));
    assert.doesNotMatch(JSON.stringify(first.questions), /복잡한 설계·최종 검토 모델|일반 구현 모델|서버·E2E 실행과 polling 모델|문서·제한된 조사 모델|로컬 계획 디렉터리|VictoriaLogs localhost port|인계용 예비 토큰|context 한도|최대 예상 토큰/);
    assert.ok(first.questions.every(({ context }) => context.includes('Codex CLI')));
    assert.equal(first.questions.some(({ prompt }) => prompt.startsWith('이 설정으로 계속할까요?')), false, 'confirmation waits until conditional questions have been resolved');
    // Nothing was written while answers were missing.
    for (const path of ['.codex/harness.yaml', '.codex/context-budget.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/agents/EXEC.md']) assert.equal(await exists(join(root, path)), false, path);
    assert.doesNotMatch(git('status', '--short', '--untracked-files=all'), /CONTEXT\.md|docs\//);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('answering conditional setup batches applies defaults and keeps Harness files out of git status', async () => {
  const { root, run, git } = await freshProject();
  try {
    let first = await run({});
    const selected = join(root, '..', 'custom worktree location');
    let answers = {};
    let answered;
    for (let round = 0; round < 6; round += 1) {
      answers = { ...answers, ...answerBatch(first.questions, { ...BATCH_CHOICES, '워크트리 생성 위치': selected }) };
      answered = await run(answers);
      if (answered.status === 'configured') break;
      first = answered;
    }
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
    assert.deepEqual(JSON.parse(await readFile(join(root, '.codex/context-budget.json'), 'utf8')), { schema_version: 1, context_window_tokens: 128000, max_plan_tokens: 32000, handoff_reserve_tokens: 16000 });
    assert.equal(await exists(join(root, 'CONTEXT.md')), true);
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /CONTEXT\.md/);
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\//);
    git('check-ignore', '-v', '.codex/harness.yaml');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup in an existing linked worktree shows Codex/worktree context and keeps that worktree', async () => {
  const { root, primary, cleanupRoot, run, git } = await freshProject({ linked: true });
  try {
    const before = git('worktree', 'list', '--porcelain');
    let batch = await run({});
    assert.ok(batch.questions.length > 0);
    assert.ok(batch.questions.every(({ context }) => context.includes('현재 실행 환경: Codex CLI')));
    assert.ok(batch.questions.every(({ context }) => context.includes('이미 생성된 linked worktree (feature/setup)')));
    assert.ok(batch.questions.every(({ context }) => context.includes('현재 worktree를 유지합니다')));
    assert.doesNotMatch(JSON.stringify(batch.questions), /워크트리 생성 위치|향후 workflow worktree 생성 상위 경로/);
    let answers = {};
    for (let round = 0; round < 6; round += 1) {
      assert.doesNotMatch(JSON.stringify(batch.questions), /워크트리 생성 위치|향후 workflow worktree 생성 상위 경로/);
      answers = { ...answers, ...answerBatch(batch.questions, BATCH_CHOICES) };
      batch = await run(answers);
      if (batch.status === 'configured') break;
    }
    assert.equal(batch.status, 'configured');
    assert.equal(git('worktree', 'list', '--porcelain'), before);
    const config = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    assert.ok(config.includes(`directory: ${JSON.stringify(join(primary, '..', 'project-worktrees'))}`));
  } finally { await rm(cleanupRoot, { recursive: true, force: true }); }
});

test('setup rejects a relative worktree location', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    await assert.rejects(run(answerBatch(first.questions, { ...BATCH_CHOICES, '워크트리 생성 위치': 'relative/path' })), /절대 경로/);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('changing the provider asks only the model choices and effort values that no longer fit', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    const provider = first.questions.find(({ prompt }) => prompt === '실행 provider 선택');
    const batchAnswers = { ...answerBatch(first.questions, BATCH_CHOICES), [provider.id]: 'codex' };
    const models = await run(batchAnswers);
    const answeredModels = { ...batchAnswers, ...answerBatch(models.questions, BATCH_CHOICES) };
    const efforts = await run(answeredModels);
    const completeCodexChoices = { ...answeredModels, ...answerBatch(efforts.questions, BATCH_CHOICES) };
    const followUp = await run({ ...completeCodexChoices, [provider.id]: 'claude-code' });
    assert.equal(followUp.status, 'needs_input');
    const asked = followUp.questions.map(({ prompt }) => prompt);
    assert.deepEqual(asked, MODELS.map(([title]) => `${title} 모델 선택`));
    assert.doesNotMatch(JSON.stringify(followUp.questions), /로컬 계획 디렉터리|VictoriaLogs localhost port|context 한도|최대 예상 토큰|인계용 예비 토큰/);
    for (const question of followUp.questions.filter(({ prompt }) => prompt.endsWith('모델 선택'))) {
      assert.deepEqual(question.options.map(({ value }) => value), ['opus', 'sonnet', 'haiku']);
      assert.equal(question.previous_answer, completeCodexChoices[question.id]);
    }
    const claudeModels = { ...completeCodexChoices, [provider.id]: 'claude-code', ...answerBatch(followUp.questions, { '복잡한 설계·최종 검토 모델 모델': 'opus', '일반 구현 모델 모델': 'sonnet', '서버·E2E 실행과 polling 모델 모델': 'sonnet', '문서·제한된 조사 모델 모델': 'haiku' }) };
    const effortBatch = await run(claudeModels);
    const effortsAsked = effortBatch.questions.map(({ prompt }) => prompt);
    assert.deepEqual(effortsAsked, ['복잡한 설계·최종 검토 모델 추론 강도 선택']);
    const effort = effortBatch.questions[0];
    assert.equal(effort.previous_answer, 'xhigh');
    assert.deepEqual(effort.options.map(({ value }) => value), ['low', 'medium', 'high']);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);

    const confirmed = await run({ ...claudeModels, [effort.id]: 'high' });
    assert.deepEqual(confirmed.questions.map(({ prompt }) => prompt), ['이 설정으로 계속할까요?']);
    const resolved = await run({ ...claudeModels, [effort.id]: 'high', [confirmed.questions[0].id]: 'y' });
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

test('choosing GitHub omits local plan storage and disabled observability omits its configuration questions', async () => {
  const { root, run } = await freshProject();
  try {
    const first = await run({});
    const tracker = first.questions.find(({ prompt }) => prompt === 'Tracker 선택');
    // GitHub questions appear after the tracker choice; unrelated local storage and disabled observability stay absent.
    const github = await run({ ...answerBatch(first.questions, BATCH_CHOICES), [tracker.id]: 'github' });
    assert.equal(github.status, 'needs_input');
    const prompts = github.questions.map(({ prompt }) => prompt);
    assert.ok(prompts.includes('GitHub repository (owner/repo)'));
    assert.ok(prompts.some((prompt) => prompt.endsWith('모델 선택')));
    assert.doesNotMatch(JSON.stringify(github.questions), /로컬 계획 디렉터리|VictoriaLogs localhost port|보존 일수|Actuator|service 이름|프로젝트 Git root|context 한도|최대 예상 토큰|인계용 예비 토큰/);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// These use the observed async UI wire format, through the installed CLI rather than overwriting its answer map.
async function showBatch(project, batch, callId = `call_${batch.batch_id}`) {
  const { root, answers, command } = project;
  const timestamp = new Date().toISOString();
  const events = [
    { type: 'session_meta', payload: { id: 'setup-test-session', cwd: root } },
    { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: callId, arguments: JSON.stringify({ questions: batch.ui_questions }) } },
    { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' } },
  ];
  const transcript = join(answers, '..', 'rollout.jsonl');
  await writeFile(transcript, events.map((event) => JSON.stringify(event)).join('\n'));
  const status = command('--bind-ui', transcript);
  assert.equal(status.can_continue, false);
  assert.deepEqual(status.missing_question_ids, batch.questions.map(({ id }) => id));
  const selected = answerBatch(batch.questions, { ...BATCH_CHOICES, 'Tracker 선택': 'github', 'GitHub repository': 'example/project', 'Project owner': 'example', 'GitHub Project 선택': '8' });
  return batch.questions.map((question, index) => ({
    questionItemId: JSON.stringify(['request_user_input_async', callId, index]),
    question: batch.ui_questions[index].title.replace(/\s+/g, ' '),
    answer: question.options ? question.options.find(({ value }) => value === selected[question.id]).label : selected[question.id],
  }));
}

async function receive(project, replies) {
  const file = join(project.answers, '..', 'reply.txt');
  await writeFile(file, `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`);
  return project.command('--receive', file);
}

test('installed setup collects individual reordered answers, advances on the last, and applies only after final confirmation', async () => {
  const project = await freshProject();
  const { root, run, command, answers, bin, git, sourceRoot } = project;
  try {
    // GitHub discovery stays deterministic and offline; no remote writes are allowed in this check.
    await writeFile(join(bin, 'gh'), '#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==="project"&&a[1]==="list")console.log(JSON.stringify({projects:[{number:8,title:"Workflow"}]}));else if(a[0]==="project"&&a[1]==="field-list")console.log(JSON.stringify({fields:[{name:"Workflow Status",type:"ProjectV2SingleSelectField",options:["Planned","In Progress","Blocked","Done"].map(name=>({name}))}]}));else if(!["auth","api","repo"].includes(a[0]))process.exit(9);\n');
    await chmod(join(bin, 'gh'), 0o755);
    let batch = await run({});
    const initial = await readFile(answers, 'utf8');
    assert.equal(command('--status').can_continue, false);
    assert.equal(await readFile(answers, 'utf8'), initial, 'status is read-only');
    assert.deepEqual(command().ui_questions, batch.ui_questions, 'an unbound retry keeps the same form');
    let oldReply;
    const batches = [];
    for (let round = 0; round < 12; round += 1) {
      assert.equal(batch.status, 'needs_input');
      batches.push(batch);
      assert.doesNotMatch(JSON.stringify(batch.questions), /로컬 계획 디렉터리|VictoriaLogs localhost port|로그 보존 일수|Actuator|Spring service/);
      const replies = await showBatch(project, batch);
      if (oldReply) {
        const ignored = await receive(project, [oldReply]);
        assert.equal(ignored.ignored, 1);
        assert.equal(ignored.missing_question_ids.length, replies.length);
      }
      const reversed = [...replies].reverse();
      for (const [index, reply] of reversed.entries()) {
        const status = await receive(project, [reply]);
        assert.equal(status.can_continue, index === reversed.length - 1);
        assert.equal(status.missing_question_ids.length, reversed.length - index - 1);
        assert.deepEqual(await receive(project, [reply]), status, 'duplicate delivery is idempotent');
        if (index !== reversed.length - 1) assert.equal(command().status, 'waiting', 'partial replies cannot run discovery/application');
      }
      for (const path of ['.codex/harness.yaml', '.codex/context-budget.json', 'CONTEXT.md', 'docs/agents/EXEC.md']) assert.equal(await exists(join(root, path)), false, path);
      assert.equal(command('--status').status, 'ready');
      oldReply = replies[0];
      batch = command();
      if (batch.status === 'configured') break;
    }
    assert.equal(batch.status, 'configured');
    assert.deepEqual(batches.at(-1).questions.map(({ prompt }) => prompt), ['이 설정으로 계속할까요?']);
    assert.equal(command('--status').can_continue, false);
    assert.match(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), /mode: "github"/);
    const config = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    await receive(project, [oldReply]);
    assert.equal(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), config);

    // Update preserves app-owned changes and restores the newly required managed runtime.
    await mkdir(join(root, 'docs/contracts'), { recursive: true });
    await writeFile(join(root, 'docs/contracts/project.md'), 'project contract\n');
    await writeFile(join(root, 'app.mjs'), 'export const owned = true;\n');
    git('add', 'app.mjs');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'app');
    await writeFile(join(root, 'app.mjs'), 'export const owned = false;\n');
    const helper = '.harness/src/workflow/setup-answers.mjs';
    await rm(join(root, helper));
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path?.endsWith(helper)));
    await updateProject({ sourceRoot, targetRoot: root });
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code }) => code === 'execution_asset_missing'), false);
    assert.match(await readFile(join(root, '.agents/skills/setup/references/native-choices.md'), 'utf8'), /--receive|--bind-ui|--cancel/);
    assert.equal(command('--status').status, 'configured');
    for (const path of [helper, '.codex/scripts/harness-setup.mjs', '.agents/skills/setup/references/answer-delivery.md', '.io/runtime/setup']) git('check-ignore', '-v', path);
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, / M app\.mjs/);
    for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'docs/contracts/project.md']) assert.ok(status.includes(path), path);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\/|\.io\//);
    assert.equal(await readFile(join(root, 'app.mjs'), 'utf8'), 'export const owned = false;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelled setup ignores late form answers and cannot resume or change existing configuration', async () => {
  const project = await freshProject();
  const { root, run, command, answers } = project;
  try {
    const config = 'custom: original\n', budget = '{"original":true}\n';
    await writeFile(join(root, '.codex/harness.yaml'), config);
    await writeFile(join(root, '.codex/context-budget.json'), budget);
    const batch = await run({});
    const replies = await showBatch(project, batch);
    command('--cancel');
    const snapshot = await readFile(answers, 'utf8');
    const result = await receive(project, replies);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.can_continue, false);
    assert.equal(await readFile(answers, 'utf8'), snapshot);
    assert.equal(command().status, 'cancelled');
    assert.equal(await readFile(join(root, '.codex/harness.yaml'), 'utf8'), config);
    assert.equal(await readFile(join(root, '.codex/context-budget.json'), 'utf8'), budget);
    assert.equal(await exists(join(root, 'CONTEXT.md')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup refuses unverified calls, acceptance payloads, mismatched items and conflicting duplicates', async () => {
  const project = await freshProject();
  const { root, run, command, answers } = project;
  try {
    const batch = await run({});
    const replies = await showBatch(project, batch);
    const snapshot = await readFile(answers, 'utf8');
    const transcript = join(answers, '..', 'rollout.jsonl');
    const valid = await readFile(transcript, 'utf8');
    await writeFile(transcript, valid.replace('setup-test-session', 'another-session'));
    assert.throws(() => command('--bind-ui', transcript), /does not match/);
    await writeFile(transcript, valid.replace('accepted\\\":true', 'accepted\\\":false'));
    assert.throws(() => command('--bind-ui', transcript), /exactly one accepted/);
    await writeFile(transcript, valid + '\n' + valid.split('\n').slice(1).join('\n'));
    assert.throws(() => command('--bind-ui', transcript), /exactly one accepted/);
    await writeFile(join(answers, '..', 'reply.txt'), '{"accepted":true}');
    assert.throws(() => command('--receive', join(answers, '..', 'reply.txt')), /actual UI reply/);
    await assert.rejects(receive(project, [{ ...replies[0], question: 'another title' }]), /does not match/);
    await assert.rejects(receive(project, [{ ...replies[0], questionItemId: JSON.stringify(['request_user_input_async', JSON.parse(replies[0].questionItemId)[1], 999]) }]), /does not match/);
    assert.equal(await readFile(answers, 'utf8'), snapshot, 'invalid messages leave all answers unchanged');
    const index = batch.questions.findIndex(({ options }) => options?.length > 1);
    await receive(project, [replies[index]]);
    const other = batch.questions[index].options.find(({ label }) => label !== replies[index].answer).label;
    await assert.rejects(receive(project, [{ ...replies[index], answer: other }]), /Conflicting duplicate/);
    assert.equal(await exists(join(root, '.codex/harness.yaml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
