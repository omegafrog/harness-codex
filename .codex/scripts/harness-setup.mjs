#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node .codex/scripts/harness-setup.mjs [--root PROJECT_ROOT] [--check | --answers SESSION_JSON]');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--check' && !options['--check']) { options['--check'] = true; i -= 1; continue; }
  if (!['--root', '--answers'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: harness-setup.mjs [--root PROJECT_ROOT] [--answers SESSION_JSON]');
  options[args[i]] = args[i + 1];
}
const root = resolve(options['--root'] || process.cwd());
if (options['--check']) {
  if (options['--answers']) throw new Error('--check cannot be combined with --answers');
  const { inspectSetupConfiguration } = await import(new URL('../../.harness/src/workflow/project-readiness.mjs', import.meta.url));
  process.stdout.write(`${JSON.stringify(await inspectSetupConfiguration({ workspace_root: root }))}\n`);
  process.exit(0);
}
const execFileAsync = promisify(execFile);
const commandResult = async (command, args, cwd = root) => {
  try { return { status: 0, ...(await execFileAsync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) }; }
  catch (error) { return { status: typeof error.code === 'number' ? error.code : null, stdout: error.stdout || '', stderr: error.stderr || '', error }; }
};
let gitRoot = await commandResult('git', ['rev-parse', '--show-toplevel']);
if (gitRoot.status !== 0) {
  const initialized = await commandResult('git', ['init', '-b', 'main']);
  if (initialized.status !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  gitRoot = await commandResult('git', ['rev-parse', '--show-toplevel']);
}
if (gitRoot.status !== 0 || resolve(gitRoot.stdout.trim()) !== root) throw new Error(`--root must be the repository root: ${root}`);
const native = Boolean(options['--answers']);
let document;
if (native) {
  const output = await import(new URL('../../.harness/src/workflow/session-output.mjs', import.meta.url).href);
  const input = resolve(root, options['--answers']);
  const answerRef = relative(output.sessionDirectory(root), input).split(sep).join('/');
  if (!/^runtime\/setup\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/answers\.json$/i.test(answerRef)) throw new Error('Setup answers must belong to a unique setup session');
  output.sessionOutputPath(root, answerRef);
  document = JSON.parse(await readFile(input, 'utf8'));
  if (!document.answers || typeof document.answers !== 'object' || Array.isArray(document.answers) || Object.values(document.answers).some((value) => typeof value !== 'string')) throw new Error('answers must be a map of question IDs to selected string values');
  console.log = (...values) => process.stderr.write(values.join(' ') + '\n');
} else if (!stdin.isTTY || !stdout.isTTY) throw new Error('Setup requires an interactive terminal; Codex native choices use --answers SESSION_JSON.');
class PendingQuestion extends Error {
  constructor(batch) { super('needs_input'); this.batch = batch; }
}
// An answer that cannot be right whatever the other answers are; it is reported at once, never treated as a provisional gap.
class InvalidAnswer extends Error {}
const occurrences = new Map();
// Native mode asks every unanswered question in one round. An unanswered question joins `batch` and setup carries on with
// its current value (or the first option) as a provisional answer, so the questions that follow from it are discovered too.
// Nothing is written or created while `batch` has a question in it: requireComplete() stops before any such step.
const batch = [];
const unanswered = new Set();
let lastQuestionId = null;
let baseDependencies = [];
// `dependsOn` lists earlier question IDs this question's existence or options come from. A selection that no longer fits
// because such an answer changed is asked again; one with no dependency that does not fit is an error. A `revisit`
// question is the final confirmation: it is consumed only when nothing else is pending, otherwise it is asked again.
function nativeAnswer(prompt, current = '', choices = null, context = null, { dependsOn = [], revisit = false } = {}) {
  const count = (occurrences.get(prompt) || 0) + 1;
  occurrences.set(prompt, count);
  const id = `${prompt}#${count}`;
  lastQuestionId = id;
  const given = Object.hasOwn(document.answers, id) ? document.answers[id] : undefined;
  const fits = given !== undefined && (!choices || choices.some((option) => option.value === given));
  if (given !== undefined && !fits && !dependsOn.length) throw new InvalidAnswer(`Invalid or stale selection for ${id}`);
  if (fits && !(revisit && batch.length)) return choices ? given : given || current;
  const parents = [...new Set([...baseDependencies, ...dependsOn])].filter((parent) => unanswered.has(parent));
  batch.push({ id, prompt, type: choices ? 'select' : 'text', current, ...(choices ? { options: choices } : {}), ...(context ? { context } : {}), ...(parents.length ? { depends_on: parents } : {}), ...(given !== undefined ? { previous_answer: given } : {}) });
  unanswered.add(id);
  return choices ? (choices.some((option) => option.value === current) ? current : choices[0]?.value ?? '') : current;
}
const requireComplete = () => { if (batch.length) throw new PendingQuestion(batch); };
// A section whose later questions cannot be derived from provisional answers ends there, and setup still looks at the rest.
const explore = async (section) => {
  try { return await section(); }
  catch (error) { if (error instanceof PendingQuestion || error instanceof InvalidAnswer || !batch.length) throw error; }
};
const rl = native ? null : createInterface({ input: stdin, output: stdout });
const ask = async (label, initial = '', extra = {}) => native ? nativeAnswer(label, initial, null, null, extra) : (await rl.question(`${label}${initial ? ` [${initial}]` : ''}: `)).trim() || initial;
const choose = async (label, options, current = '', context = null, extra = {}) => {
  if (native) return nativeAnswer(label, current, options, context, extra);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}${option.value === current ? ' (현재값)' : ''}`));
  for (;;) {
    const answer = await ask(label), index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
    const match = options.find((option) => option.value === answer);
    if (match) return match.value;
    console.log('목록의 번호 또는 정확한 값을 입력해 주세요.');
  }
};
const confirm = async (label, initial = 'n', context = null, extra = {}) => {
  if (native) return nativeAnswer(label, initial, [{ value: 'y', label: '예' }, { value: 'n', label: '아니요' }], context, extra) === 'y';
  for (;;) {
    const answer = (await ask(`${label} (y/n)`, initial)).toLowerCase();
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    console.log('y 또는 n을 입력해 주세요.');
  }
};
const exec = async (command, args, cwd = root) => {
  const result = await commandResult(command, args, cwd);
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  return result.stdout.trim();
};

async function readModelList() {
  const child = spawn(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const lines = createInterface({ input: child.stdout }), pending = new Map();
  lines.on('line', (line) => {
    try { const message = JSON.parse(line); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } } catch {}
  });
  const request = (id, method, params) => new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex app-server did not answer ${method}`)); }, 10000);
    pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolveRequest(message.result); });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request(1, 'initialize', { clientInfo: { name: 'harness-setup', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const result = await request(2, 'model/list', { includeHidden: false, limit: 100 });
    if (!Array.isArray(result.data) || result.data.length === 0) throw new Error('Codex returned no selectable models');
    return result.data;
  } finally { child.kill(); }
}

function setYamlScalar(source, path, value) {
  const lines = source.replace(/\r/g, '').split('\n');
  const directSection = (parentPath) => {
    let start = 0, end = lines.length, parentIndent = -2;
    for (const key of parentPath) {
      const indent = parentIndent + 2, pattern = new RegExp(`^\\s{${indent}}${key}:\\s*(?:#.*)?$`);
      let index = -1;
      for (let i = start; i < end; i += 1) if (pattern.test(lines[i])) { index = i; break; }
      if (index < 0) {
        const line = `${' '.repeat(indent)}${key}:`;
        lines.splice(end, 0, line);
        index = end;
        end = lines.length;
      } else {
        end = index + 1;
        while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith('#') || lines[end].search(/\S/) > indent)) end += 1;
      }
      start = index;
      parentIndent = indent;
    }
    return { start, end, indent: parentIndent + 2 };
  };
  const parent = directSection(path.slice(0, -1)), key = path.at(-1), indent = parent.indent;
  const pattern = new RegExp(`^\\s{${indent}}${key}:`);
  let index = -1;
  for (let i = parent.start + (path.length > 1 ? 1 : 0); i < parent.end; i += 1) if (pattern.test(lines[i])) { index = i; break; }
  const line = `${' '.repeat(indent)}${key}: ${JSON.stringify(value)}`;
  if (index >= 0) lines[index] = line;
  else lines.splice(parent.end, 0, line);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function hasLocalBeadsDatabase(path, depth = 3) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (/^(embeddeddolt|dolt|.*\.db)$/i.test(entry.name)) return true;
    if (depth > 0 && entry.isDirectory() && await hasLocalBeadsDatabase(join(path, entry.name), depth - 1)) return true;
  }
  return false;
}

async function setupBeads() {
  let version = await commandResult('bd', ['version']);
  if (version.status !== 0) {
    console.log('Beads CLI가 설치되어 있지 않습니다.');
    if (!await confirm('npm install --global @beads/bd 를 실행할까요?')) throw new Error('Beads CLI 설치가 승인되지 않아 setup을 중단했습니다.');
    await exec('npm', ['install', '--global', '@beads/bd']);
    version = await commandResult('bd', ['version']);
    if (version.status !== 0) throw new Error(`Beads 설치 후에도 CLI 실행 실패: ${version.stderr || version.error?.message}`);
  }

  const current = await commandResult('bd', ['where']);
  if (current.status === 0) {
    await exec('bd', ['status']);
    console.log('기존 Beads workspace를 보존했습니다.');
    return;
  }

  const origin = await commandResult('git', ['remote', 'get-url', 'origin']);
  if (origin.error) throw origin.error;
  if (origin.status !== 0 && !/No such remote/i.test(origin.stderr || '')) throw new Error(`Git origin 확인 실패: ${origin.stderr || `exit ${origin.status}`}`);
  const remote = origin.status === 0 ? await commandResult('git', ['ls-remote', 'origin', 'refs/dolt/data']) : { status: 0, stdout: '' };
  if (remote.status !== 0) throw new Error(`Beads 원격 workspace 확인 실패: ${remote.stderr || remote.error?.message || `exit ${remote.status}`}`);
  if (remote.stdout.trim()) {
    const preview = await commandResult('bd', ['bootstrap', '--dry-run']);
    if (preview.status !== 0) throw new Error(`Beads bootstrap 사전 확인 실패: ${preview.stderr || preview.error?.message}`);
    console.log(preview.stdout);
    if (!await confirm('기존 원격 Beads workspace를 이 프로젝트에서 채택할까요?')) throw new Error('Beads 원격 채택이 승인되지 않아 setup을 중단했습니다.');
    await exec('bd', ['bootstrap']);
  } else {
    if (await hasLocalBeadsDatabase(join(root, '.beads'))) throw new Error('기존 로컬 Beads database가 있으나 활성 workspace가 아닙니다. 데이터를 보존하고 setup을 중단했습니다.');
    if (!await confirm('원격 데이터가 없습니다. 새 Beads workspace를 초기화할까요?')) throw new Error('Beads 초기화가 승인되지 않아 setup을 중단했습니다.');
    await exec('bd', ['init', '--skip-agents', '--init-if-missing']);
  }
  await exec('bd', ['status']);
  console.log('Beads workspace 준비 완료.');
}

async function prepareProjectFiles() {
  const seedFiles = [
    ['CONTEXT.md', '.codex/skills/setup/assets/CONTEXT.md'],
    ['CONTEXT-MAP.md', '.codex/skills/setup/assets/CONTEXT-MAP.md'],
    ['docs/agents/implementation-guidance.md', '.codex/internal-skills/implementation-guidance/references/template.md'],
    ['docs/agents/testing-guidance.md', '.codex/internal-skills/testing-guidance/references/template.md'],
  ];
  for (const [target, source] of seedFiles) {
    const targetPath = join(root, target);
    if (await lstat(targetPath).catch(() => null)) { console.log(`Preserved ${target}`); continue; }
    const installedSource = source.replace('.codex/skills/', '.agents/skills/');
    const sourcePath = [join(root, installedSource), join(root, source), join(scriptRoot, source)].find(existsSync);
    if (!sourcePath) throw new Error(`Missing setup template: ${source}`);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    console.log(`Created ${target}`);
  }
  for (const [target, content] of Object.entries({
    'docs/agents/EXEC.md': '',
    'docs/agents/execution.json': '{"schema_version":1,"profiles":{}}\n',
    'docs/contracts/product.md': '',
    'docs/contracts/architecture.md': '',
    'docs/contracts/manifest.json': '{}\n',
    'docs/contracts/architecture.html': '',
  })) {
    const targetPath = join(root, target);
    await mkdir(dirname(targetPath), { recursive: true });
    try { await writeFile(targetPath, content, { flag: 'wx' }); console.log(`Created ${target}`); }
    catch (error) { if (error.code !== 'EEXIST') throw error; console.log(`Preserved ${target}`); }
  }
  const gitignore = join(root, '.gitignore');
  const ignoreText = await readFile(gitignore, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  if (!/^\.io\/$/m.test(ignoreText)) await writeFile(gitignore, `${ignoreText}${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}# Harness runtime-only artifacts\n.io/\n`);
}

async function prepareCodexSubagentHook(provider) {
  if (provider !== 'codex') return;
  const { syncCodexSubagentHook, inspectCodexHookTrust } = await import(new URL('../../.harness/src/workflow/providers/codex.mjs', import.meta.url).href);
  const synced = await syncCodexSubagentHook();
  if (synced.changed) console.log(`Codex 사용자 hook에 Harness subagent 기록 hook을 추가했습니다: ${synced.path}`);
  const trust = await inspectCodexHookTrust();
  if (trust.orchestrator_hook !== 'trusted') console.log('Codex에서 /hooks를 열어 "Running Harness orchestrator hook"(UserPromptSubmit·PostToolUse·Stop)을 신뢰로 승인하세요. 한 번 승인하면 새 worktree마다 hook을 다시 리뷰하지 않습니다.');
  if (trust.fresh_agent_check !== 'trusted') console.log('Codex에서 /hooks를 열어 "Checking Harness fresh agent" hook(PreToolUse)도 신뢰로 승인하세요. 리뷰어·E2E runner를 대화 fork로 띄우는 호출을 시작 전에 거부합니다.');
  if (trust.write_guard !== 'trusted') console.log('Codex에서 /hooks를 열어 "Guarding Harness orchestrator writes" hook(PreToolUse)도 신뢰로 승인하세요. workflow worktree의 메인 세션이 제품 코드·테스트·docs/contracts를 직접 고치는 것을 거부합니다.');
  if (!trust.trusted) console.log('Codex에서 /hooks를 열어 "Recording Harness subagent" hook(SubagentStart·SubagentStop)을 신뢰로 승인하세요. 승인 전에는 workflow stage를 시작할 수 없습니다. 한 번 승인하면 모든 프로젝트와 worktree에 적용됩니다.');
}

const currentProviderOf = (config) => ['codex', 'claude-code'].includes(config.agents?.provider) ? config.agents.provider : 'codex';

async function main() {
  const parserUrl = new URL('../../.harness/src/eval/yaml.mjs', import.meta.url);
  const { parseYaml } = await import(parserUrl.href);
  const { modelBelongsToProvider } = await import(new URL('../../.harness/src/workflow/providers/index.mjs', import.meta.url).href);
  const configPath = join(root, '.codex/harness.yaml');
  const oldConfig = await readFile(configPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const budgetPath = join(root, '.codex/context-budget.json');
  const oldBudget = await readFile(budgetPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  // Settings from versions that kept one flat set of model keys move under the active provider first.
  const { AGENT_TIERS, migrateAgentsText, providerAgents } = await import(new URL('../../.harness/src/workflow/agent-config.mjs', import.meta.url).href);
  const config = parseYaml(migrateAgentsText(oldConfig).text);
  const { inspectSetupConfiguration, hasTrackerConfiguration } = await import(new URL('../../.harness/src/workflow/project-readiness.mjs', import.meta.url));
  const existing = await inspectSetupConfiguration({ workspace_root: root });
  const hasExisting = Boolean(config.agents && Object.keys(config.agents).length || config.tracker?.mode);
  const reuse = hasExisting && await choose('기존 설정을 사용하거나 다시 설정할까요?', [
    { value: 'reuse', label: '기존 설정 사용' }, { value: 'reconfigure', label: '새로 설정' },
  ], 'reuse', { agents: config.agents || {}, tracker: config.tracker || {}, beads: config.beads || {}, observability: config.observability || {} }) === 'reuse';
  // Reusing or reconfiguring decides which of the later questions exist, so each of them is marked as depending on it.
  if (hasExisting && native) baseDependencies = [lastQuestionId];
  const hasWorktreeDirectory = typeof config.worktrees?.directory === 'string' && isAbsolute(config.worktrees.directory) && !config.worktrees.directory.includes('\0');
  if (reuse && hasWorktreeDirectory && existing.violations.every((item) => item.startsWith('Missing or invalid CONTEXT'))) {
    requireComplete();
    await prepareProjectFiles();
    await prepareCodexSubagentHook(currentProviderOf(config));
    console.log('기존 설정을 유지했습니다.');
    return;
  }
  // The tier names are shared with the skill declarations and workflow stages that choose among them.
  const tiers = AGENT_TIERS;
  const hasText = (value) => typeof value === 'string' && Boolean(value.trim()) && !value.startsWith('agents.');
  const worktreeDirectory = reuse && hasWorktreeDirectory ? config.worktrees.directory : await ask('워크트리 생성 위치 (절대 경로)', hasWorktreeDirectory ? config.worktrees.directory : join(dirname(root), `${basename(root)}-worktrees`));
  if (!isAbsolute(worktreeDirectory) || worktreeDirectory.includes('\0')) throw new Error('워크트리 생성 위치는 절대 경로여야 합니다.');
  const validEffort = (value) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value);
  const currentProvider = ['codex', 'claude-code'].includes(config.agents?.provider) ? config.agents.provider : 'codex';
  // Only providers this installation carries can be chosen (install --provider codex|claude-code|all).
  const exists = (path) => existsSync(join(root, path));
  const offered = [
    ...(exists('.agents/skills/orchestrator/SKILL.md') ? [{ value: 'codex', label: 'Codex CLI' }] : []),
    ...(exists('.claude/harness/providers/claude-code.mjs') ? [{ value: 'claude-code', label: 'Claude Code CLI' }] : []),
  ];
  if (!offered.length) throw new Error('No agent provider is installed; run harness-codex install --provider codex|claude-code|all');
  if (reuse && !offered.some((item) => item.value === currentProvider)) throw new Error(`agents.provider is ${currentProvider}, which is not installed; install it or choose a new setup`);
  const provider = reuse ? currentProvider : await choose('실행 provider 선택', offered, offered.some((item) => item.value === currentProvider) ? currentProvider : offered[0].value, { agents: config.agents || {} });
  // The provider decides the model list, and each model decides its effort list.
  const providerDeps = !reuse && native ? [lastQuestionId] : [];
  const validProviderEffort = (value) => provider === 'claude-code' ? ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) : validEffort(value);
  const claudeModels = [
    { id: 'opus', description: '복잡한 설계·최종 검토' },
    { id: 'sonnet', description: '일반 구현·실행' },
    { id: 'haiku', description: '문서·제한된 조사' },
  ].map((model) => ({ ...model, supportedReasoningEfforts: ['low', 'medium', 'high'] }));
  const providerSettings = providerAgents(config, provider);
  const needsModelList = provider === 'codex' && (!reuse || tiers.some((key) => !hasText(providerSettings[`${key}_model`]) || !modelBelongsToProvider(provider, providerSettings[`${key}_model`]) || !validProviderEffort(providerSettings[`${key}_reasoning_effort`])));
  const models = provider === 'codex' ? (needsModelList ? await readModelList() : []) : claudeModels;
  const selection = {};
  for (const [key, title, recommendation] of [
    ['high_performance', '복잡한 설계·최종 검토 모델', provider === 'claude-code' ? 'opus' : '가장 높은 추론 성능'],
    ['implementation', '일반 구현 모델', provider === 'claude-code' ? 'sonnet' : '가벼운 모델과 high effort'],
    ['execution', '서버·E2E 실행과 polling 모델', provider === 'claude-code' ? 'sonnet' : '균형 잡힌 모델과 medium effort'],
    ['low_performance', '문서·제한된 조사 모델', provider === 'claude-code' ? 'haiku' : '가장 가벼운 모델과 low effort'],
  ]) {
    console.log(`\n${title} — 권장: ${recommendation}`);
    models.forEach((model, index) => console.log(`  ${index + 1}) ${model.id} — ${model.description || model.displayName}${model.id === providerSettings[`${key}_model`] ? ' (현재값)' : ''}`));
    const currentModel = providerSettings[`${key}_model`];
    const currentEffort = providerSettings[`${key}_reasoning_effort`];
    const preferred = provider === 'claude-code' ? (key === 'high_performance' ? 'opus' : key === 'low_performance' ? 'haiku' : 'sonnet') : currentModel || '';
    const selectedCurrentModel = reuse && hasText(currentModel) && modelBelongsToProvider(provider, currentModel) && (provider === 'codex' || models.some((item) => item.id === currentModel)) ? currentModel : '';
    const model = selectedCurrentModel || await choose(`${title} 모델 선택`, models.map((item) => ({ value: item.id, label: item.id })), preferred, null, { dependsOn: providerDeps });
    const modelDeps = selectedCurrentModel || !native ? [] : [lastQuestionId];
    let effort = currentEffort;
    if (!(reuse && selectedCurrentModel && validProviderEffort(currentEffort))) {
      const selected = models.find((item) => item.id === model);
      if (!selected) throw new Error(`Configured model is unavailable: ${model}`);
      const efforts = selected.supportedReasoningEfforts.map((item) => typeof item === 'string' ? ({ value: item, label: item }) : ({ value: item.reasoningEffort, label: `${item.reasoningEffort} — ${item.description}` }));
      effort = await choose(`${title} 추론 강도 선택`, efforts, currentEffort || 'medium', null, { dependsOn: [...providerDeps, ...modelDeps] });
    }
    selection[`${key}_model`] = model;
    selection[`${key}_reasoning_effort`] = effort;
  }
  selection.default_model = selection.low_performance_model;

  let previousBudget = {};
  try { if (oldBudget) previousBudget = JSON.parse(oldBudget); } catch {}
  const { validateContextBudget } = await import(new URL('../../.harness/src/workflow/skill-execution.mjs', import.meta.url));
  let validBudget = false;
  try { validateContextBudget(previousBudget); validBudget = true; } catch {}
  const budgetKeys = ['context_window_tokens', 'max_plan_tokens', 'handoff_reserve_tokens'];
  const missingBudgetField = budgetKeys.some((key) => !Number.isSafeInteger(previousBudget[key]) || previousBudget[key] <= 0);
  const contextBudget = { schema_version: 1 };
  for (const [key, prompt] of [['context_window_tokens', '선택 모델 공통 context 한도(tokens)'], ['max_plan_tokens', 'plan 하나의 최대 예상 토큰'], ['handoff_reserve_tokens', 'checkpoint·인계용 예비 토큰']]) {
    const useCurrent = reuse && (validBudget || missingBudgetField) && Number.isSafeInteger(previousBudget[key]) && previousBudget[key] > 0;
    const answer = useCurrent ? String(previousBudget[key]) : await ask(prompt, previousBudget[key] === undefined ? '' : String(previousBudget[key]));
    contextBudget[key] = answer.trim() ? Number(answer) : NaN;
  }
  // A provisional answer is often blank; the numbers are validated once every answer is in.
  try { validateContextBudget(contextBudget); } catch (error) { if (!batch.length) throw error; }

  console.log('\n티켓 추적 방식');
  const reuseTracker = reuse && hasTrackerConfiguration(config.tracker);
  const trackerChosen = reuse && ['local-markdown', 'github'].includes(config.tracker?.mode);
  const mode = trackerChosen ? config.tracker.mode : await choose('Tracker 선택', [
    { value: 'local-markdown', label: 'local-markdown' },
    { value: 'github', label: 'GitHub Project' },
  ], config.tracker?.mode);
  // Which tracker questions exist follows from the chosen mode, and a project's questions from its owner and repository.
  const trackerDeps = trackerChosen || !native ? [] : [lastQuestionId];
  const idOfLast = (asked) => asked && native ? [lastQuestionId] : [];
  let tracker, createRepository = null;
  await explore(async () => {
  if (reuseTracker) tracker = config.tracker;
  else if (mode === 'local-markdown') {
    const current = config.tracker?.local_markdown?.directory;
    const directory = reuse && hasText(current) ? current : await ask('로컬 계획 디렉터리', current || 'docs/plans', { dependsOn: trackerDeps });
    if (!directory || directory.startsWith('/') || directory.split(/[\\/]/).includes('..')) throw new Error('로컬 계획 디렉터리는 프로젝트 상대경로여야 합니다.');
    tracker = { mode, local_markdown: { ...(config.tracker?.local_markdown || {}), directory } };
  } else {
    const existingGithub = config.tracker?.github || {};
    const reuseRepository = reuse && /^[\w.-]+\/[\w.-]+$/.test(existingGithub.repository || '');
    const repository = reuseRepository ? existingGithub.repository : await ask('GitHub repository (owner/repo)', existingGithub.repository || '', { dependsOn: trackerDeps });
    const repositoryDeps = [...trackerDeps, ...idOfLast(!reuseRepository)];
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('repository는 owner/repo 형식이어야 합니다.');
    if (!reuseRepository) {
      const repositoryCheck = await commandResult('gh', ['api', `repos/${repository}`, '--jq', '.name']);
      if (repositoryCheck.status !== 0) {
        if (!/HTTP 404/.test(repositoryCheck.stderr || '')) throw new Error(`GitHub repository 확인 실패: ${repositoryCheck.stderr || repositoryCheck.error?.message}`);
        const visibility = await choose('새 GitHub repository 공개 범위', [{ value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }], '', null, { dependsOn: repositoryDeps });
        createRepository = { repository, visibility };
      }
    }
    const reuseOwner = reuse && hasText(existingGithub.project_owner);
    const owner = reuseOwner ? existingGithub.project_owner : await ask('Project owner', existingGithub.project_owner || repository.split('/')[0], { dependsOn: repositoryDeps });
    const ownerDeps = [...repositoryDeps, ...idOfLast(!reuseOwner)];
    let chosen;
    if (reuse && Number.isSafeInteger(existingGithub.project_number) && existingGithub.project_number > 0) chosen = String(existingGithub.project_number);
    else {
      let projects = JSON.parse(await exec('gh', ['project', 'list', '--owner', owner, '--format', 'json', '--limit', '200'])).projects || [];
      if (!projects.length) {
        const title = `${repository.split('/')[1]}-workflow`;
        if (!await confirm(`Project가 없습니다. '${title}'을 만들까요?`, 'n', null, { dependsOn: ownerDeps })) throw new Error('GitHub Project가 선택되지 않았습니다.');
        requireComplete();
        await exec('gh', ['project', 'create', '--owner', owner, '--title', title]);
        projects = JSON.parse(await exec('gh', ['project', 'list', '--owner', owner, '--format', 'json', '--limit', '200'])).projects || [];
      }
      chosen = await choose('GitHub Project 선택', projects.map((item) => ({ value: String(item.number), label: `#${item.number} ${item.title}` })), String(existingGithub.project_number || ''), null, { dependsOn: ownerDeps });
    }
    let statusField = reuse && hasText(existingGithub.status_field) ? { name: existingGithub.status_field } : null;
    if (!statusField) {
    const fields = JSON.parse(await exec('gh', ['project', 'field-list', chosen, '--owner', owner, '--format', 'json'])).fields || [];
    statusField = fields.find((field) => field.name === 'Workflow Status' && field.type === 'ProjectV2SingleSelectField');
    if (!statusField) {
      if (!await confirm('Workflow Status 필드(Planned, In Progress, Blocked, Done)를 만들까요?', 'n', null, { dependsOn: ownerDeps })) throw new Error('Workflow Status 필드가 없어 설정을 중단했습니다.');
      requireComplete();
      await exec('gh', ['project', 'field-create', chosen, '--owner', owner, '--name', 'Workflow Status', '--data-type', 'SINGLE_SELECT', '--single-select-options', 'Planned,In Progress,Blocked,Done']);
      statusField = { name: 'Workflow Status' };
    }
    const options = statusField.options?.map((option) => option.name) || [];
    if (['Planned', 'In Progress', 'Blocked', 'Done'].some((name) => !options.includes(name))) {
      const refreshed = JSON.parse(await exec('gh', ['project', 'field-list', chosen, '--owner', owner, '--format', 'json'])).fields || [];
      statusField = refreshed.find((field) => field.name === 'Workflow Status' && field.type === 'ProjectV2SingleSelectField');
      const refreshedOptions = statusField?.options?.map((option) => option.name) || [];
      if (!statusField || ['Planned', 'In Progress', 'Blocked', 'Done'].some((name) => !refreshedOptions.includes(name))) throw new Error('Workflow Status의 네 상태를 API에서 확인하지 못했습니다.');
    }
    }
    tracker = { mode, github: { ...existingGithub, repository, project_owner: owner, project_number: Number(chosen), status_field: statusField.name, assignees: { spec_me: existingGithub.assignees?.spec_me || '@me', codex: existingGithub.assignees?.codex || '@copilot' } } };
  }
  });

  const reuseBeads = reuse && typeof config.beads?.enabled === 'boolean';
  const reuseObservability = reuse && typeof config.observability?.victorialogs?.local?.enabled === 'boolean';
  const useBeads = reuseBeads ? config.beads.enabled : await confirm('Beads를 프로젝트 작업 보드로 사용할까요?', config.beads?.enabled === false ? 'n' : 'y');
  const useVictoriaLogs = reuseObservability ? config.observability.victorialogs.local.enabled : await confirm('로컬 관측성(OpenTelemetry Collector + VictoriaLogs + VictoriaMetrics + 공식 MCP 2개)을 구성할까요?', config.observability?.victorialogs?.local?.enabled === false ? 'n' : 'y');
  // The port and project questions exist only when observability is configured.
  const observabilityDeps = reuseObservability || !native ? [] : [lastQuestionId];
  const askInteger = async (label, initial, max) => {
    for (;;) {
      const value = Number(await ask(label, String(initial), { dependsOn: observabilityDeps }));
      if (Number.isInteger(value) && value >= 1 && value <= max) return value;
      console.log(`1~${max} 사이 정수를 입력해 주세요.`);
    }
  };
  const configureObservability = useVictoriaLogs && !reuseObservability;
  const logPort = configureObservability ? await askInteger('VictoriaLogs localhost port', config.observability?.victorialogs?.local?.port || 9428, 65535) : null;
  const retentionDays = configureObservability ? await askInteger('로그 보존 일수', config.observability?.victorialogs?.local?.retention_days || 7, 30) : null;
  const metricsPort = configureObservability ? await askInteger('VictoriaMetrics localhost port', config.observability?.victoriametrics?.local?.port || 8428, 65535) : null;
  const otelPort = configureObservability ? await askInteger('OpenTelemetry Collector OTLP HTTP localhost port', config.observability?.opentelemetry?.local?.port || 4318, 65535) : null;
  if (configureObservability && new Set([logPort, metricsPort, otelPort]).size !== 3) throw new Error('로그·메트릭·OTLP 포트는 달라야 합니다.');
  const metricsRetention = configureObservability ? await askInteger('메트릭 보존 일수', config.observability?.victoriametrics?.local?.retention_days || 7, 30) : null;
  let projects = [];
  if (configureObservability) await explore(async () => {
    console.log('Docker bridge를 사용합니다. 앱→Collector는 localhost 공개 포트, 컨테이너→WSL 앱은 host.docker.internal 주소를 사용합니다.');
    const previous = await readFile(join(root, 'docs/observability/victorialogs/config.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code !== 'ENOENT') throw error; return {}; });
    if (previous.projects?.length && previous.projects.every((item) => item.services.every((service) => service.scrape_url)) && await confirm('기존 프로젝트·Actuator 대상 목록을 유지할까요?', 'y', null, { dependsOn: observabilityDeps })) projects = previous.projects;
    else {
      do {
        const projectRoot = resolve(await ask('수집할 프로젝트 Git root', projects.length ? '' : root, { dependsOn: observabilityDeps }));
        if (await exec('git', ['rev-parse', '--show-toplevel'], projectRoot) !== projectRoot) throw new Error('프로젝트 Git root를 입력해야 합니다.');
        const id = await ask('프로젝트 ID (영문·숫자·_·-)', projectRoot.split('/').at(-1), { dependsOn: observabilityDeps });
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || projects.some((item) => item.id === id || item.root === projectRoot)) throw new Error('프로젝트 ID와 root는 유일해야 합니다.');
        const services = [];
        do {
          const name = await ask('Spring service 이름 (spring.application.name)', '', { dependsOn: observabilityDeps });
          const metrics_url = await ask('Actuator Prometheus 전체 URL (실제 포트 포함)', '', { dependsOn: observabilityDeps });
          const metricsUrlDeps = [...observabilityDeps, ...(native ? [lastQuestionId] : [])];
          const url = new URL(metrics_url);
          if (!/^[a-zA-Z0-9_.-]+$/.test(name) || services.some((item) => item.name === name) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('서비스 이름 또는 Actuator URL이 올바르지 않습니다. 비밀값 없는 HTTP(S) URL을 입력하세요.');
          const suggested = new URL(metrics_url);
          if (['127.0.0.1', 'localhost', '[::1]'].includes(suggested.hostname)) suggested.hostname = 'host.docker.internal';
          const scrape_url = await ask('컨테이너에서 접근할 Actuator URL (Docker Desktop/WSL은 host.docker.internal)', suggested.href, { dependsOn: metricsUrlDeps });
          const scrape = new URL(scrape_url);
          if (!['http:', 'https:'].includes(scrape.protocol) || scrape.username || scrape.password || scrape.search || scrape.hash) throw new Error('비밀값 없는 컨테이너용 Actuator HTTP(S) URL을 입력하세요.');
          services.push({ name, metrics_url, scrape_url });
        } while (await confirm('이 프로젝트에 서비스를 더 등록할까요?', 'n', null, { dependsOn: observabilityDeps }));
        projects.push({ id, root: projectRoot, services });
      } while (await confirm('다른 프로젝트를 더 등록할까요?', 'n', null, { dependsOn: observabilityDeps }));
    }
  });
  console.log('\n선택 요약');
  console.log(`  provider: ${provider}`);
  for (const [key, value] of Object.entries(selection)) console.log(`  ${key}: ${value}`);
  console.log(`  tracker: ${mode}`);
  console.log(`  Beads: ${useBeads ? '사용' : '사용 안 함'}`);
  console.log(`  VictoriaLogs local: ${reuseObservability ? '기존 설정 유지' : useVictoriaLogs ? `logs ${logPort}/${retentionDays}일, metrics ${metricsPort}/${metricsRetention}일, OTLP ${otelPort}` : '건너뜀'}`);
  for (const project of projects) console.log(`  ${project.id}: ${project.root} — ${project.services.map((service) => `${service.name} ${service.metrics_url} → scrape ${service.scrape_url}`).join(', ')}`);
  // The summary needs every answer, so while any question is pending the confirmation is asked in the same batch and
  // covers the answers given in it; it is asked again whenever a later round brings new or changed answers.
  const summary = { worktrees: { directory: worktreeDirectory }, agents: { provider, ...selection }, context_budget: contextBudget, tracker, create_repository: createRepository, beads: useBeads, observability: { enabled: useVictoriaLogs, logPort, retentionDays, metricsPort, metricsRetention, otelPort, projects } };
  const approved = await confirm('이 설정으로 계속할까요?', 'n', batch.length ? { provisional: true, note: '이 질문들에 대한 답으로 설정을 적용합니다. 요약은 모든 답을 받은 뒤에만 정해집니다.' } : summary, { dependsOn: [...unanswered], revisit: true });
  requireComplete();
  if (!approved) throw new Error('사용자가 설정 적용을 취소했습니다.');
  if (createRepository) {
    const origin = await commandResult('git', ['remote', 'get-url', 'origin']);
    if (origin.status === 0) throw new Error('기존 origin을 보존했습니다. 새 repository를 연결하기 전에 origin을 확인하세요.');
    await exec('gh', ['repo', 'create', createRepository.repository, `--${createRepository.visibility}`, '--source', root, '--remote', 'origin']);
  }
  if (useBeads) await setupBeads();

  const currentConfig = await readFile(configPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const currentBudget = await readFile(budgetPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  let configText = migrateAgentsText(currentConfig).text;
  if (!reuse || !hasWorktreeDirectory) configText = setYamlScalar(configText, ['worktrees', 'directory'], worktreeDirectory);
  if (!reuse || !hasText(config.agents?.provider)) configText = setYamlScalar(configText, ['agents', 'provider'], provider);
  // Each provider keeps its own section, so choosing another provider later leaves these models in place.
  for (const [key, value] of Object.entries(selection)) if (!reuse || !(key.endsWith('_reasoning_effort') ? validEffort(providerSettings[key]) : hasText(providerSettings[key]))) configText = setYamlScalar(configText, ['agents', provider, key], value);
  if (!reuse || !['local-markdown', 'github'].includes(config.tracker?.mode)) configText = setYamlScalar(configText, ['tracker', 'mode'], mode);
  if (!reuseTracker && mode === 'local-markdown' && (!reuse || !hasText(config.tracker?.local_markdown?.directory))) configText = setYamlScalar(configText, ['tracker', 'local_markdown', 'directory'], tracker.local_markdown.directory);
  else if (!reuseTracker) {
    for (const [key, value] of Object.entries(mode === 'github' ? { repository: tracker.github.repository, project_owner: tracker.github.project_owner, project_number: tracker.github.project_number, status_field: tracker.github.status_field, spec_me: tracker.github.assignees.spec_me, codex: tracker.github.assignees.codex } : {})) {
      const path = key === 'spec_me' || key === 'codex' ? ['tracker', 'github', 'assignees', key] : ['tracker', 'github', key];
      const prior = key === 'spec_me' || key === 'codex' ? config.tracker?.github?.assignees?.[key] : config.tracker?.github?.[key];
      if (reuse && (key === 'project_number' ? Number.isSafeInteger(prior) && prior > 0 : hasText(prior))) continue;
      configText = setYamlScalar(configText, path, value);
    }
  }
  if (!reuseBeads) configText = setYamlScalar(configText, ['beads', 'enabled'], useBeads);
  if (!reuseObservability) for (const provider of ['victorialogs', 'victoriametrics', 'opentelemetry']) configText = setYamlScalar(configText, ['observability', provider, 'local', 'enabled'], useVictoriaLogs);
  if (configureObservability) {
    configText = setYamlScalar(configText, ['observability', 'opentelemetry', 'local', 'port'], otelPort);
    configText = setYamlScalar(configText, ['observability', 'victoriametrics', 'local', 'port'], metricsPort);
    configText = setYamlScalar(configText, ['observability', 'victoriametrics', 'local', 'retention_days'], metricsRetention);
    configText = setYamlScalar(configText, ['observability', 'victorialogs', 'local', 'port'], logPort);
    configText = setYamlScalar(configText, ['observability', 'victorialogs', 'local', 'retention_days'], retentionDays);
    if (config.observability?.signoz?.local?.enabled) configText = setYamlScalar(configText, ['observability', 'signoz', 'local', 'enabled'], false);
  }
  const output = await import(new URL('../../.harness/src/workflow/session-output.mjs', import.meta.url).href);
  let finalBudget = contextBudget;
  if (reuse && !validBudget && missingBudgetField && currentBudget) {
    try { finalBudget = { ...JSON.parse(currentBudget), schema_version: 1 }; } catch { finalBudget = { schema_version: 1 }; }
    for (const key of budgetKeys) if (!Number.isSafeInteger(previousBudget[key]) || previousBudget[key] <= 0) finalBudget[key] = contextBudget[key];
    validateContextBudget(finalBudget);
  }
  const backup = output.sessionOutputPath(root, `runtime/setup/backups/harness-${Date.now()}.yaml`);
  await mkdir(dirname(backup), { recursive: true });
  if (currentConfig) await writeFile(backup, currentConfig, { mode: 0o600 });
  if (currentBudget) await writeFile(`${backup}.context-budget.json`, currentBudget, { mode: 0o600 });
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = output.sessionOutputPath(root, `tmp/setup-${Date.now()}.yaml`);
  await writeFile(temporary, configText, { mode: 0o600 });
  await rename(temporary, configPath);
  if (!reuse || !validBudget) {
    const temporaryBudget = output.sessionOutputPath(root, `tmp/context-budget-${Date.now()}.json`);
    await writeFile(temporaryBudget, `${JSON.stringify(finalBudget, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryBudget, budgetPath);
  }

  await prepareProjectFiles();
  console.log(`Updated .codex/harness.yaml${oldConfig ? `; backup: ${backup}` : ''}`);
  console.log(`Tracker configured: ${mode}`);
  if (useBeads) console.log('Beads workspace 상태를 확인했습니다.');
  if (configureObservability) {
    await exec(process.execPath, [join(root, '.codex/scripts/harness-victorialogs.mjs'), 'setup', '--root', root, '--port', String(logPort), '--retention-days', String(retentionDays), '--metrics-port', String(metricsPort), '--metrics-retention-days', String(metricsRetention), '--otel-port', String(otelPort), '--projects', JSON.stringify(projects)]);
    console.log('OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·실행 profile·공식 MCP 두 개를 준비했습니다. victorialogs-local-setup 스킬로 기존 앱의 개발 로그를 연결하세요.');
  }
  await prepareCodexSubagentHook(provider);
  console.log('다음 단계: 필수 파일 존재 여부를 확인하고 workflow 구성을 진행하세요.');
}

main().then(() => {
  if (native) process.stdout.write(JSON.stringify({ status: 'configured', root }) + '\n');
}).catch((error) => {
  // `pending` stays the first question for callers that still ask one at a time; `questions` is the whole batch.
  const needsInput = () => process.stdout.write(JSON.stringify({ status: 'needs_input', pending: batch[0], questions: batch }) + '\n');
  if (error instanceof PendingQuestion) needsInput();
  // An error reached only through provisional answers ends the discovery; it is raised for real once they are answered.
  else if (native && batch.length && !(error instanceof InvalidAnswer)) needsInput();
  else { console.error(error.message); process.exitCode = 1; }
}).finally(() => rl?.close());
