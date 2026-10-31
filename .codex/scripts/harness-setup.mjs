#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node .codex/scripts/harness-setup.mjs [--root PROJECT_ROOT] [--answers SESSION_JSON]');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--root', '--answers'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: harness-setup.mjs [--root PROJECT_ROOT] [--answers SESSION_JSON]');
  options[args[i]] = args[i + 1];
}
const root = resolve(options['--root'] || process.cwd());
let gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
if (gitRoot.status !== 0) {
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
}
if (gitRoot.status !== 0 || resolve(gitRoot.stdout.trim()) !== root) throw new Error(`--root must be the repository root: ${root}`);
const native = Boolean(options['--answers']);
let document, configurationHash;
if (native) {
  const output = await import(new URL(existsSync(join(root, '.codex/harness-runtime/src/workflow/session-output.mjs')) ? '../harness-runtime/src/workflow/session-output.mjs' : '../../src/workflow/session-output.mjs', import.meta.url).href);
  const input = resolve(root, options['--answers']);
  output.sessionOutputPath(root, relative(output.sessionDirectory(root), input));
  document = JSON.parse(await readFile(input, 'utf8'));
  if (!document.answers || typeof document.answers !== 'object' || Array.isArray(document.answers) || Object.values(document.answers).some((value) => typeof value !== 'string')) throw new Error('answers must be a map of question IDs to selected string values');
  console.log = (...values) => process.stderr.write(values.join(' ') + '\n');
} else if (!stdin.isTTY || !stdout.isTTY) throw new Error('Setup requires an interactive terminal; Codex native choices use --answers SESSION_JSON.');
class PendingQuestion extends Error {
  constructor(question) { super('needs_input'); this.question = question; }
}
const occurrences = new Map();
function nativeAnswer(prompt, current = '', choices = null, context = null) {
  const count = (occurrences.get(prompt) || 0) + 1;
  occurrences.set(prompt, count);
  const id = `${prompt}#${count}`;
  if (!Object.hasOwn(document.answers, id)) throw new PendingQuestion({ id, prompt, type: choices ? 'select' : 'text', current, ...(choices ? { options: choices } : {}), ...(context ? { context } : {}) });
  const value = document.answers[id];
  if (choices && !choices.some((option) => option.value === value)) throw new Error(`Invalid or stale selection for ${id}`);
  return choices ? value : value || current;
}
const rl = native ? null : createInterface({ input: stdin, output: stdout });
const ask = async (label, initial = '') => native ? nativeAnswer(label, initial) : (await rl.question(`${label}${initial ? ` [${initial}]` : ''}: `)).trim() || initial;
const choose = async (label, options, current = '') => {
  if (native) return nativeAnswer(label, current, options);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}${option.value === current ? ' (현재값)' : ''}`));
  for (;;) {
    const answer = await ask(label), index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
    const match = options.find((option) => option.value === answer);
    if (match) return match.value;
    console.log('목록의 번호 또는 정확한 값을 입력해 주세요.');
  }
};
const confirm = async (label, initial = 'n', context = null) => {
  if (native) return nativeAnswer(label, initial, [{ value: 'y', label: '예' }, { value: 'n', label: '아니요' }], context) === 'y';
  for (;;) {
    const answer = (await ask(`${label} (y/n)`, initial)).toLowerCase();
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    console.log('y 또는 n을 입력해 주세요.');
  }
};
const exec = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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

const commandResult = (command, args, cwd = root) => spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
async function hasLocalBeadsDatabase(path, depth = 3) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (/^(embeddeddolt|dolt|.*\.db)$/i.test(entry.name)) return true;
    if (depth > 0 && entry.isDirectory() && await hasLocalBeadsDatabase(join(path, entry.name), depth - 1)) return true;
  }
  return false;
}

async function setupBeads() {
  let version = commandResult('bd', ['version']);
  if (version.status !== 0) {
    console.log('Beads CLI가 설치되어 있지 않습니다.');
    if (!await confirm('npm install --global @beads/bd 를 실행할까요?')) throw new Error('Beads CLI 설치가 승인되지 않아 setup을 중단했습니다.');
    exec('npm', ['install', '--global', '@beads/bd']);
    version = commandResult('bd', ['version']);
    if (version.status !== 0) throw new Error(`Beads 설치 후에도 CLI 실행 실패: ${version.stderr || version.error?.message}`);
  }

  const current = commandResult('bd', ['where']);
  if (current.status === 0) {
    exec('bd', ['status']);
    console.log('기존 Beads workspace를 보존했습니다.');
    return;
  }

  const remote = commandResult('git', ['ls-remote', 'origin', 'refs/dolt/data']);
  if (remote.status !== 0) throw new Error(`Beads 원격 workspace 확인 실패: ${remote.stderr || remote.error?.message || `exit ${remote.status}`}`);
  if (remote.stdout.trim()) {
    const preview = commandResult('bd', ['bootstrap', '--dry-run']);
    if (preview.status !== 0) throw new Error(`Beads bootstrap 사전 확인 실패: ${preview.stderr || preview.error?.message}`);
    console.log(preview.stdout);
    if (!await confirm('기존 원격 Beads workspace를 이 프로젝트에서 채택할까요?')) throw new Error('Beads 원격 채택이 승인되지 않아 setup을 중단했습니다.');
    exec('bd', ['bootstrap']);
  } else {
    if (await hasLocalBeadsDatabase(join(root, '.beads'))) throw new Error('기존 로컬 Beads database가 있으나 활성 workspace가 아닙니다. 데이터를 보존하고 setup을 중단했습니다.');
    if (!await confirm('원격 데이터가 없습니다. 새 Beads workspace를 초기화할까요?')) throw new Error('Beads 초기화가 승인되지 않아 setup을 중단했습니다.');
    exec('bd', ['init', '--skip-agents', '--init-if-missing']);
  }
  exec('bd', ['status']);
  console.log('Beads workspace 준비 완료.');
}

async function main() {
  const models = await readModelList();
  const parserUrl = existsSync(join(root, '.codex/harness-runtime/src/eval/yaml.mjs'))
    ? new URL('../harness-runtime/src/eval/yaml.mjs', import.meta.url)
    : new URL('../../src/eval/yaml.mjs', import.meta.url);
  const { parseYaml } = await import(parserUrl.href);
  const configPath = join(root, '.codex/harness.yaml');
  const oldConfig = await readFile(configPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const budgetPath = join(root, '.codex/context-budget.json');
  const oldBudget = await readFile(budgetPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  configurationHash = createHash('sha256').update(oldConfig).update(oldBudget).digest('hex');
  if (native && Object.keys(document.answers).length && document.configuration_hash !== configurationHash) throw new Error('Project configuration changed; restart native setup with current choices');
  const config = parseYaml(oldConfig);
  const selection = {};
  for (const [key, title, recommendation] of [
    ['high_performance', '복잡한 설계·최종 검토 모델', '가장 높은 추론 성능'],
    ['implementation', '일반 구현 모델', '가벼운 모델과 high effort'],
    ['execution', '서버·E2E 실행과 polling 모델', '균형 잡힌 모델과 medium effort'],
    ['low_performance', '문서·제한된 조사 모델', '가장 가벼운 모델과 low effort'],
  ]) {
    console.log(`\n${title} — 권장: ${recommendation}`);
    models.forEach((model, index) => console.log(`  ${index + 1}) ${model.id} — ${model.description || model.displayName}${model.id === config.agents?.[`${key}_model`] ? ' (현재값)' : ''}`));
    const model = await choose(`${title} 모델 선택`, models.map((item) => ({ value: item.id, label: item.id })), config.agents?.[`${key}_model`]);
    const selected = models.find((item) => item.id === model);
    const efforts = selected.supportedReasoningEfforts.map((item) => ({ value: item.reasoningEffort, label: `${item.reasoningEffort} — ${item.description}` }));
    const effort = await choose(`${title} 추론 강도 선택`, efforts, config.agents?.[`${key}_reasoning_effort`]);
    selection[`${key}_model`] = model;
    selection[`${key}_reasoning_effort`] = effort;
  }
  selection.default_model = selection.low_performance_model;

  const previousBudget = oldBudget ? JSON.parse(oldBudget) : {};
  const contextBudget = { schema_version: 1 };
  for (const [key, prompt] of [['context_window_tokens', '선택 모델 공통 context 한도(tokens)'], ['max_plan_tokens', 'plan 하나의 최대 예상 토큰'], ['handoff_reserve_tokens', 'checkpoint·인계용 예비 토큰']]) {
    const answer = await ask(prompt, previousBudget[key] === undefined ? '' : String(previousBudget[key]));
    contextBudget[key] = answer.trim() ? Number(answer) : NaN;
  }
  const budgetModule = new URL(existsSync(join(root, '.codex/harness-runtime/src/workflow/skill-execution.mjs')) ? '../harness-runtime/src/workflow/skill-execution.mjs' : '../../src/workflow/skill-execution.mjs', import.meta.url);
  const { validateContextBudget } = await import(budgetModule.href);
  validateContextBudget(contextBudget);

  console.log('\n티켓 추적 방식');
  const mode = await choose('Tracker 선택', [
    { value: 'local-markdown', label: 'local-markdown' },
    { value: 'github', label: 'GitHub Project' },
  ], config.tracker?.mode);
  let tracker, createRepository = null;
  if (mode === 'local-markdown') {
    tracker = { mode, local_markdown: { ...(config.tracker?.local_markdown || {}), directory: 'docs/plans' } };
  } else {
    const repository = await ask('GitHub repository (owner/repo)', config.tracker?.github?.repository || '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('repository는 owner/repo 형식이어야 합니다.');
    const repositoryCheck = spawnSync('gh', ['api', `repos/${repository}`, '--jq', '.name'], { cwd: root, encoding: 'utf8' });
    if (repositoryCheck.status !== 0) {
      if (!/HTTP 404/.test(repositoryCheck.stderr || '')) throw new Error(`GitHub repository 확인 실패: ${repositoryCheck.stderr || repositoryCheck.error?.message}`);
      const visibility = await choose('새 GitHub repository 공개 범위', [{ value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }]);
      createRepository = { repository, visibility };
    }
    const owner = await ask('Project owner', config.tracker?.github?.project_owner || repository.split('/')[0]);
    let projects = JSON.parse(exec('gh', ['project', 'list', '--owner', owner, '--format', 'json', '--limit', '200'])).projects || [];
    if (!projects.length) {
      const title = `${repository.split('/')[1]}-workflow`;
      if (!await confirm(`Project가 없습니다. '${title}'을 만들까요?`)) throw new Error('GitHub Project가 선택되지 않았습니다.');
      exec('gh', ['project', 'create', '--owner', owner, '--title', title]);
      projects = JSON.parse(exec('gh', ['project', 'list', '--owner', owner, '--format', 'json', '--limit', '200'])).projects || [];
    }
    const chosen = await choose('GitHub Project 선택', projects.map((item) => ({ value: String(item.number), label: `#${item.number} ${item.title}` })), String(config.tracker?.github?.project_number || ''));
    const fields = JSON.parse(exec('gh', ['project', 'field-list', chosen, '--owner', owner, '--format', 'json'])).fields || [];
    let statusField = fields.find((field) => field.name === 'Workflow Status' && field.type === 'ProjectV2SingleSelectField');
    if (!statusField) {
      if (!await confirm('Workflow Status 필드(Planned, In Progress, Blocked, Done)를 만들까요?')) throw new Error('Workflow Status 필드가 없어 설정을 중단했습니다.');
      exec('gh', ['project', 'field-create', chosen, '--owner', owner, '--name', 'Workflow Status', '--data-type', 'SINGLE_SELECT', '--single-select-options', 'Planned,In Progress,Blocked,Done']);
      statusField = { name: 'Workflow Status' };
    }
    const options = statusField.options?.map((option) => option.name) || [];
    if (['Planned', 'In Progress', 'Blocked', 'Done'].some((name) => !options.includes(name))) {
      const refreshed = JSON.parse(exec('gh', ['project', 'field-list', chosen, '--owner', owner, '--format', 'json'])).fields || [];
      statusField = refreshed.find((field) => field.name === 'Workflow Status' && field.type === 'ProjectV2SingleSelectField');
      const refreshedOptions = statusField?.options?.map((option) => option.name) || [];
      if (!statusField || ['Planned', 'In Progress', 'Blocked', 'Done'].some((name) => !refreshedOptions.includes(name))) throw new Error('Workflow Status의 네 상태를 API에서 확인하지 못했습니다.');
    }
    tracker = { mode, github: { ...(config.tracker?.github || {}), repository, project_owner: owner, project_number: Number(chosen), status_field: 'Workflow Status', assignees: { spec_me: config.tracker?.github?.assignees?.spec_me || '@me', codex: config.tracker?.github?.assignees?.codex || '@copilot' } } };
  }

  const useBeads = await confirm('Beads를 프로젝트 작업 보드로 사용할까요?', config.beads?.enabled === false ? 'n' : 'y');
  const useVictoriaLogs = await confirm('로컬 관측성(OpenTelemetry Collector + VictoriaLogs + VictoriaMetrics + 공식 MCP 2개)을 구성할까요?', config.observability?.victorialogs?.local?.enabled === false ? 'n' : 'y');
  const askInteger = async (label, initial, max) => {
    for (;;) {
      const value = Number(await ask(label, String(initial)));
      if (Number.isInteger(value) && value >= 1 && value <= max) return value;
      console.log(`1~${max} 사이 정수를 입력해 주세요.`);
    }
  };
  const logPort = useVictoriaLogs ? await askInteger('VictoriaLogs localhost port', config.observability?.victorialogs?.local?.port || 9428, 65535) : null;
  const retentionDays = useVictoriaLogs ? await askInteger('로그 보존 일수', config.observability?.victorialogs?.local?.retention_days || 7, 30) : null;
  const metricsPort = useVictoriaLogs ? await askInteger('VictoriaMetrics localhost port', config.observability?.victoriametrics?.local?.port || 8428, 65535) : null;
  const otelPort = useVictoriaLogs ? await askInteger('OpenTelemetry Collector OTLP HTTP localhost port', config.observability?.opentelemetry?.local?.port || 4318, 65535) : null;
  if (useVictoriaLogs && new Set([logPort, metricsPort, otelPort]).size !== 3) throw new Error('로그·메트릭·OTLP 포트는 달라야 합니다.');
  const metricsRetention = useVictoriaLogs ? await askInteger('메트릭 보존 일수', config.observability?.victoriametrics?.local?.retention_days || 7, 30) : null;
  let projects = [];
  if (useVictoriaLogs) {
    console.log('Docker bridge를 사용합니다. 앱→Collector는 localhost 공개 포트, 컨테이너→WSL 앱은 host.docker.internal 주소를 사용합니다.');
    const previous = await readFile(join(root, 'docs/observability/victorialogs/config.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code !== 'ENOENT') throw error; return {}; });
    if (previous.projects?.length && previous.projects.every((item) => item.services.every((service) => service.scrape_url)) && await confirm('기존 프로젝트·Actuator 대상 목록을 유지할까요?', 'y')) projects = previous.projects;
    else {
      do {
        const projectRoot = resolve(await ask('수집할 프로젝트 Git root', projects.length ? '' : root));
        if (exec('git', ['rev-parse', '--show-toplevel'], projectRoot) !== projectRoot) throw new Error('프로젝트 Git root를 입력해야 합니다.');
        const id = await ask('프로젝트 ID (영문·숫자·_·-)', projectRoot.split('/').at(-1));
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || projects.some((item) => item.id === id || item.root === projectRoot)) throw new Error('프로젝트 ID와 root는 유일해야 합니다.');
        const services = [];
        do {
          const name = await ask('Spring service 이름 (spring.application.name)');
          const metrics_url = await ask('Actuator Prometheus 전체 URL (실제 포트 포함)');
          const url = new URL(metrics_url);
          if (!/^[a-zA-Z0-9_.-]+$/.test(name) || services.some((item) => item.name === name) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('서비스 이름 또는 Actuator URL이 올바르지 않습니다. 비밀값 없는 HTTP(S) URL을 입력하세요.');
          const suggested = new URL(metrics_url);
          if (['127.0.0.1', 'localhost', '[::1]'].includes(suggested.hostname)) suggested.hostname = 'host.docker.internal';
          const scrape_url = await ask('컨테이너에서 접근할 Actuator URL (Docker Desktop/WSL은 host.docker.internal)', suggested.href);
          const scrape = new URL(scrape_url);
          if (!['http:', 'https:'].includes(scrape.protocol) || scrape.username || scrape.password || scrape.search || scrape.hash) throw new Error('비밀값 없는 컨테이너용 Actuator HTTP(S) URL을 입력하세요.');
          services.push({ name, metrics_url, scrape_url });
        } while (await confirm('이 프로젝트에 서비스를 더 등록할까요?'));
        projects.push({ id, root: projectRoot, services });
      } while (await confirm('다른 프로젝트를 더 등록할까요?'));
    }
  }
  console.log('\n선택 요약');
  for (const [key, value] of Object.entries(selection)) console.log(`  ${key}: ${value}`);
  console.log(`  tracker: ${mode}`);
  console.log(`  Beads: ${useBeads ? '사용' : '사용 안 함'}`);
  console.log(`  VictoriaLogs local: ${useVictoriaLogs ? `logs ${logPort}/${retentionDays}일, metrics ${metricsPort}/${metricsRetention}일, OTLP ${otelPort}` : '건너뜀'}`);
  for (const project of projects) console.log(`  ${project.id}: ${project.root} — ${project.services.map((service) => `${service.name} ${service.metrics_url} → scrape ${service.scrape_url}`).join(', ')}`);
  if (!await confirm('이 설정으로 계속할까요?', 'n', { agents: selection, context_budget: contextBudget, tracker, create_repository: createRepository, beads: useBeads, observability: { enabled: useVictoriaLogs, logPort, retentionDays, metricsPort, metricsRetention, otelPort, projects } })) throw new Error('사용자가 설정 적용을 취소했습니다.');
  if (createRepository) {
    const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
    if (origin.status === 0) throw new Error('기존 origin을 보존했습니다. 새 repository를 연결하기 전에 origin을 확인하세요.');
    exec('gh', ['repo', 'create', createRepository.repository, `--${createRepository.visibility}`, '--source', root, '--remote', 'origin']);
  }
  if (useBeads) await setupBeads();

  let configText = oldConfig || '';
  for (const [key, value] of Object.entries(selection)) configText = setYamlScalar(configText, ['agents', key], value);
  configText = setYamlScalar(configText, ['tracker', 'mode'], mode);
  if (mode === 'local-markdown') configText = setYamlScalar(configText, ['tracker', 'local_markdown', 'directory'], tracker.local_markdown.directory);
  else {
    for (const [key, value] of Object.entries({ repository: tracker.github.repository, project_owner: tracker.github.project_owner, project_number: tracker.github.project_number, status_field: tracker.github.status_field, spec_me: tracker.github.assignees.spec_me, codex: tracker.github.assignees.codex })) {
      const path = key === 'spec_me' || key === 'codex' ? ['tracker', 'github', 'assignees', key] : ['tracker', 'github', key];
      configText = setYamlScalar(configText, path, value);
    }
  }
  configText = setYamlScalar(configText, ['beads', 'enabled'], useBeads);
  configText = setYamlScalar(configText, ['observability', 'victorialogs', 'local', 'enabled'], useVictoriaLogs);
  configText = setYamlScalar(configText, ['observability', 'victoriametrics', 'local', 'enabled'], useVictoriaLogs);
  configText = setYamlScalar(configText, ['observability', 'opentelemetry', 'local', 'enabled'], useVictoriaLogs);
  if (useVictoriaLogs) {
    configText = setYamlScalar(configText, ['observability', 'opentelemetry', 'local', 'port'], otelPort);
    configText = setYamlScalar(configText, ['observability', 'victoriametrics', 'local', 'port'], metricsPort);
    configText = setYamlScalar(configText, ['observability', 'victoriametrics', 'local', 'retention_days'], metricsRetention);
    configText = setYamlScalar(configText, ['observability', 'victorialogs', 'local', 'port'], logPort);
    configText = setYamlScalar(configText, ['observability', 'victorialogs', 'local', 'retention_days'], retentionDays);
    if (config.observability?.signoz?.local?.enabled) configText = setYamlScalar(configText, ['observability', 'signoz', 'local', 'enabled'], false);
  }
  const output = await import(new URL(existsSync(join(root, '.codex/harness-runtime/src/workflow/session-output.mjs')) ? '../harness-runtime/src/workflow/session-output.mjs' : '../../src/workflow/session-output.mjs', import.meta.url).href);
  const backup = output.sessionOutputPath(root, `runtime/setup/backups/harness-${Date.now()}.yaml`);
  await mkdir(dirname(backup), { recursive: true });
  if (oldConfig) await writeFile(backup, oldConfig, { mode: 0o600 });
  if (oldBudget) await writeFile(`${backup}.context-budget.json`, oldBudget, { mode: 0o600 });
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = output.sessionOutputPath(root, `tmp/setup-${Date.now()}.yaml`);
  await writeFile(temporary, configText, { mode: 0o600 });
  await rename(temporary, configPath);
  const temporaryBudget = output.sessionOutputPath(root, `tmp/context-budget-${Date.now()}.json`);
  await writeFile(temporaryBudget, `${JSON.stringify(contextBudget, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryBudget, budgetPath);

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
  console.log(`Updated .codex/harness.yaml${oldConfig ? `; backup: ${backup}` : ''}`);
  console.log(`Tracker configured: ${mode}`);
  if (useBeads) console.log('Beads workspace verification/initialization remains a separate explicit step: run bd status, and initialize only after checking local and remote data.');
  if (useVictoriaLogs) {
    exec(process.execPath, [join(root, '.codex/scripts/harness-victorialogs.mjs'), 'setup', '--root', root, '--port', String(logPort), '--retention-days', String(retentionDays), '--shared-guidance-root', root, '--metrics-port', String(metricsPort), '--metrics-retention-days', String(metricsRetention), '--otel-port', String(otelPort), '--projects', JSON.stringify(projects)]);
    console.log('OpenTelemetry Collector·VictoriaLogs·VictoriaMetrics·실행 profile·공식 MCP 두 개를 준비했습니다. victorialogs-local-setup 스킬로 기존 앱의 개발 로그를 연결하세요.');
  }
  console.log('다음 단계: 필수 파일 존재 여부를 확인하고 workflow 구성을 진행하세요.');
}

main().then(() => {
  if (native) process.stdout.write(JSON.stringify({ status: 'configured', root }) + '\n');
}).catch((error) => {
  if (error instanceof PendingQuestion) process.stdout.write(JSON.stringify({ status: 'needs_input', configuration_hash: configurationHash, question: error.question }) + '\n');
  else { console.error(error.message); process.exitCode = 1; }
}).finally(() => rl?.close());
