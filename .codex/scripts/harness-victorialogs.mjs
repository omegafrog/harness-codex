#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = existsSync(new URL('../harness-runtime/src/workflow/session-output.mjs', import.meta.url))
  ? '../harness-runtime/src/workflow/session-output.mjs' : '../../src/workflow/session-output.mjs';
const { sessionDirectory, sessionOutputPath } = await import(new URL(runtime, import.meta.url).href);
const args = process.argv.slice(2);
const action = args.shift();
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--root', '--port', '--retention-days', '--input', '--shared-guidance-root', '--metrics-port', '--metrics-retention-days', '--otel-port', '--projects'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error('Expected setup|validate|start|stop|check|mcp --root DIR [--port N --retention-days N]');
  options[args[i]] = args[i + 1];
}
if (!['setup', 'validate', 'start', 'stop', 'check', 'mcp', 'mcp-metrics', 'validate-logs'].includes(action)) throw new Error('Expected setup|validate|start|stop|check|mcp');
if (action !== 'setup' && ['--port', '--retention-days', '--metrics-port', '--metrics-retention-days', '--otel-port', '--projects'].some((key) => options[key])) throw new Error('Runtime uses config.json; port and retention options are only valid for setup');
if (action !== 'validate-logs' && options['--input']) throw new Error('--input requires validate-logs');
if (action !== 'setup' && options['--shared-guidance-root']) throw new Error('--shared-guidance-root requires setup');
const root = await realpath(resolve(options['--root'] || process.cwd()));
const git = (argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
if (await realpath(git(['rev-parse', '--show-toplevel'])) !== root) throw new Error('--root must be the repository root');
const directory = join(root, 'docs/observability/victorialogs');
const project = `harness-vl-${createHash('sha256').update(await realpath(git(['rev-parse', '--path-format=absolute', '--git-common-dir']))).digest('hex').slice(0, 12)}`;
const configPath = join(directory, 'config.json');
const integer = (value, min, max, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${label}: ${value}`);
  return number;
};
async function safePath(path, base = root) {
  const suffix = relative(base, path);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Configuration path escapes its project root');
  let current = base;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error(`Symlink is not allowed in observability configuration: ${current}`);
  }
}
async function normalizeConfig(config) {
  const normalized = {
    ...config,
    port: integer(config.port, 1, 65535, 'port'),
    retention_days: integer(config.retention_days, 1, 30, 'retention days'),
    otel_port: integer(config.otel_port ?? 4318, 1, 65535, 'OTLP HTTP port'),
    metrics_port: integer(config.metrics_port ?? 8428, 1, 65535, 'metrics port'),
    metrics_retention_days: integer(config.metrics_retention_days ?? 7, 1, 30, 'metrics retention days'),
    projects: config.projects ?? [{ id: 'project', root, services: [] }],
  };
  if (new Set([normalized.port, normalized.metrics_port, normalized.otel_port]).size !== 3) throw new Error('Logs, metrics and OTLP ports must differ');
  if (!Array.isArray(normalized.projects) || !normalized.projects.length) throw new Error('At least one project is required');
  const ids = new Set(), roots = new Set();
  for (const item of normalized.projects) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error('Project IDs must be unique safe names');
    if (typeof item.root !== 'string' || !isAbsolute(item.root)) throw new Error('Project root must be absolute');
    item.root = await realpath(item.root);
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: item.root, encoding: 'utf8' }).trim();
    const common = await realpath(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: item.root, encoding: 'utf8' }).trim());
    if (await realpath(top) !== item.root || roots.has(common)) throw new Error('Project roots must identify distinct Git repositories');
    ids.add(item.id); roots.add(common);
    if (!Array.isArray(item.services)) throw new Error('Project services must be an array');
    const services = new Set();
    for (const service of item.services) {
      if (!service || typeof service.name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(service.name) || services.has(service.name)) throw new Error('Service names must be unique within a project');
      for (const value of [service.metrics_url, service.scrape_url ?? service.metrics_url]) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Metrics URL must be HTTP(S), without credentials, query or fragment');
      }
      services.add(service.name);
    }
  }
  return normalized;
}
const readConfig = async () => {
  await safePath(configPath);
  return normalizeConfig(JSON.parse(await readFile(configPath, 'utf8')));
};
async function replaceConfig(path, text, base = root) {
  await safePath(path, base);
  if (existsSync(path)) {
    if (await readFile(path, 'utf8') === text) return;
    await copyFile(path, sessionOutputPath(root, `runtime/setup/backups/${path.split(sep).at(-1)}-${Date.now()}`));
  }
  const temporary = sessionOutputPath(root, `tmp/observability-${Date.now()}.tmp`);
  await writeFile(temporary, text);
  await rename(temporary, path);
}
function scrapeConfig(config) {
  return { global: { scrape_interval: '15s', scrape_timeout: '5s' }, scrape_configs: config.projects.flatMap((item) => item.services.map((service) => {
    const app = new URL(service.metrics_url);
    if (!service.scrape_url && ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) throw new Error('A loopback metrics_url needs an explicit container-visible scrape_url; run setup again');
    const url = new URL(service.scrape_url ?? service.metrics_url);
    return { job_name: `${item.id}/${service.name}`, scheme: url.protocol.slice(0, -1), metrics_path: url.pathname,
      static_configs: [{ targets: [url.host], labels: { project: item.id, service: service.name } }] };
  })) };
}
function assetSource(name) {
  const source = [join(root, '.agents/skills/victorialogs-local-setup/assets', name), join(sourceRoot, '.codex/skills/victorialogs-local-setup/assets', name)].find(existsSync);
  if (!source) throw new Error(`Missing VictoriaLogs asset: ${name}`);
  return source;
}
async function validateLogFile() {
  if (!options['--input']) throw new Error('validate-logs requires --input FILE');
  const schemaPath = join(directory, 'diagnostic-log.schema.json');
  const schema = JSON.parse(await readFile(existsSync(schemaPath) ? schemaPath : assetSource('diagnostic-log.schema.json'), 'utf8'));
  const validator = existsSync(new URL('../harness-runtime/src/observability/diagnostic-logs.mjs', import.meta.url))
    ? '../harness-runtime/src/observability/diagnostic-logs.mjs' : '../../src/observability/diagnostic-logs.mjs';
  const { validateDiagnosticLog } = await import(new URL(validator, import.meta.url).href);
  let records = 0, invalid = 0;
  const violations = [];
  const inspect = (text, line) => {
    if (!text.trim()) return;
    records++;
    let errors;
    try { errors = validateDiagnosticLog(JSON.parse(text), schema); }
    catch { errors = ['Invalid JSON or unsupported diagnostic contract']; }
    if (errors.length) {
      invalid++;
      if (violations.length < 20) violations.push({ line, errors });
    }
  };
  const input = resolve(root, options['--input']);
  if (input.endsWith('.json')) inspect(await readFile(input, 'utf8'), 1);
  else {
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    let line = 0;
    for await (const text of lines) inspect(text, ++line);
  }
  const status = records && !invalid ? 'pass' : 'fail';
  console.log(JSON.stringify({ status, records, invalid_records: invalid, violations }));
  if (status !== 'pass') process.exitCode = 1;
}
async function setupVictoriaLogs() {
  const guidanceRoot = await realpath(resolve(options['--shared-guidance-root'] || root));
  const guidanceCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: guidanceRoot, encoding: 'utf8' }).trim();
  if (await realpath(guidanceCommon) !== await realpath(git(['rev-parse', '--path-format=absolute', '--git-common-dir']))) throw new Error('shared_guidance_root must share the project Git common directory');
  const old = existsSync(configPath) ? await readConfig() : {};
  const config = await normalizeConfig({
    ...old,
    port: options['--port'] ?? old.port ?? 9428,
    retention_days: options['--retention-days'] ?? old.retention_days ?? 7,
    otel_port: options['--otel-port'] ?? old.otel_port ?? 4318,
    metrics_port: options['--metrics-port'] ?? old.metrics_port ?? 8428,
    metrics_retention_days: options['--metrics-retention-days'] ?? old.metrics_retention_days ?? 7,
    projects: options['--projects'] ? JSON.parse(options['--projects']) : old.projects,
  });
  scrapeConfig(config);
  await safePath(directory);
  await mkdir(directory, { recursive: true });
  for (const name of ['compose.yaml', 'otel-collector.yaml', 'spring-local.properties', 'README.md', 'diagnostic-log.schema.json', 'diagnostic-log-schema.md', 'diagnostic-log.example.json']) {
    const target = join(directory, name);
    await safePath(target);
    if (!existsSync(target)) await copyFile(assetSource(name), target);
  }
  // Retire the active legacy collector, retaining its files and offsets for recovery.
  const composePath = join(directory, 'compose.yaml');
  if (/^  fluent-bit:|^\s+network_mode: host$/m.test(await readFile(composePath, 'utf8'))) await replaceConfig(composePath, await readFile(assetSource('compose.yaml'), 'utf8'));
  for (const name of ['README.md', 'spring-local.properties', 'diagnostic-log-schema.md', 'otel-collector.yaml']) {
    const path = join(directory, name);
    if ((name === 'otel-collector.yaml' && !(await readFile(path, 'utf8')).includes('stack v3')) || (name === 'README.md' && !(await readFile(path, 'utf8')).includes('stack v3')) || (name === 'diagnostic-log-schema.md' && /Fluent Bit/.test(await readFile(path, 'utf8')))) await replaceConfig(path, await readFile(assetSource(name), 'utf8'));
  }
  await replaceConfig(configPath, JSON.stringify(config, null, 2) + '\n');
  await replaceConfig(join(directory, 'scrape.json'), JSON.stringify(scrapeConfig(config), null, 2) + '\n');
  await replaceConfig(join(directory, 'otel-javaagent.properties'), `# Harness development-only OpenTelemetry agent config; never package the agent in production.\notel.logs.exporter=otlp\notel.metrics.exporter=none\notel.traces.exporter=none\notel.exporter.otlp.protocol=http/protobuf\notel.exporter.otlp.logs.endpoint=http://127.0.0.1:${config.otel_port}/v1/logs\n`);
  for (const name of ['implementation-guidance.md', 'testing-guidance.md']) {
    const path = join(guidanceRoot, 'docs/agents', name);
    await safePath(path, guidanceRoot);
    const previous = await readFile(path, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return '# Project guidance\n\n## Active guidance\n\n'; });
    let updated = previous;
    for (const entry of (await readFile(assetSource(name), 'utf8')).split(/(?=^### )/m).filter((part) => part.trim())) {
      const heading = entry.split('\n')[0];
      const start = updated.indexOf(heading + '\n');
      if (start >= 0) {
        const end = updated.indexOf('\n##', start + heading.length);
        updated = updated.slice(0, start) + entry.trimEnd() + '\n\n' + (end < 0 ? '' : updated.slice(end + 1));
      } else if (updated.includes('## Superseded guidance')) updated = updated.replace('## Superseded guidance', entry.trimEnd() + '\n\n## Superseded guidance');
      else updated += '\n' + entry.trimEnd() + '\n';
    }
    await mkdir(dirname(path), { recursive: true });
    await replaceConfig(path, updated, guidanceRoot);
  }
  const mcpPath = join(directory, 'mcp.json');
  await safePath(mcpPath);
  const mcp = existsSync(mcpPath) ? JSON.parse(await readFile(mcpPath, 'utf8')) : { mcpServers: {} };
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers)) throw new Error('Invalid existing MCP configuration');
  for (const [name, command] of [['victorialogs', 'mcp'], ['victoriametrics', 'mcp-metrics']]) {
    mcp.mcpServers[name] ??= { command: 'node', args: [join(root, '.codex/scripts/harness-victorialogs.mjs'), command, '--root', root] };
  }
  await replaceConfig(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  const executionPath = join(root, 'docs/agents/execution.json');
  await safePath(executionPath);
  const execution = existsSync(executionPath) ? JSON.parse(await readFile(executionPath, 'utf8')) : { schema_version: 1, profiles: {} };
  if (execution.schema_version !== 1 || !execution.profiles || typeof execution.profiles !== 'object' || Array.isArray(execution.profiles)) throw new Error('Invalid existing execution manifest; preserve and reconcile it before setup');
  for (const [id, command] of [['victorialogs-infrastructure', 'start'], ['victorialogs-check', 'check'], ['victorialogs-stop', 'stop']]) {
    const previous = execution.profiles[id];
    if (previous && !(previous.command?.[1] === '.codex/scripts/harness-victorialogs.mjs' && previous.command?.[2] === command)) throw new Error(`Profile ${id} is user-owned; reconcile it before setup`);
    execution.profiles[id] = { ...previous, command: ['node', '.codex/scripts/harness-victorialogs.mjs', command, '--root', '.'], required_env: previous?.required_env || [], config_inputs: [...new Set([...(previous?.config_inputs || []).filter((path) => !/\/(fluent-bit|parsers)\.conf$/.test(path)), '.codex/scripts/harness-victorialogs.mjs', 'docs/observability/victorialogs/config.json', 'docs/observability/victorialogs/compose.yaml', 'docs/observability/victorialogs/otel-collector.yaml', 'docs/observability/victorialogs/scrape.json', 'docs/observability/victorialogs/otel-javaagent.properties', 'docs/agents/EXEC.md'])], prepare: previous?.prepare || [], verify_config: [...(previous?.verify_config || []).filter((argv) => argv[1] !== '.codex/scripts/harness-victorialogs.mjs'), ['node', '.codex/scripts/harness-victorialogs.mjs', 'validate', '--root', '.']], dependencies: previous?.dependencies || [], timeout_ms: command === 'start' ? 43200000 : 30000, readiness_timeout_ms: command === 'start' ? 180000 : 10000, poll_interval_ms: 1000 };
  }
  if (!execution.profiles['victorialogs-diagnostic-logs']) execution.profiles['victorialogs-diagnostic-logs'] = {
    command: ['node', '.codex/scripts/harness-victorialogs.mjs', 'validate-logs', '--root', '.', '--input', '${HARNESS_DIAGNOSTIC_LOG_FILE}'],
    required_env: ['HARNESS_DIAGNOSTIC_LOG_FILE'],
    config_inputs: ['.codex/scripts/harness-victorialogs.mjs', 'docs/observability/victorialogs/diagnostic-log.schema.json', 'docs/observability/victorialogs/diagnostic-log.example.json', existsSync(join(root, '.codex/harness-runtime/src/observability/diagnostic-logs.mjs')) ? '.codex/harness-runtime/src/observability/diagnostic-logs.mjs' : 'src/observability/diagnostic-logs.mjs'],
    prepare: [], verify_config: [['node', '.codex/scripts/harness-victorialogs.mjs', 'validate-logs', '--root', '.', '--input', 'docs/observability/victorialogs/diagnostic-log.example.json']], dependencies: [], timeout_ms: 30000, readiness_timeout_ms: 1000, poll_interval_ms: 100,
  };
  await mkdir(dirname(executionPath), { recursive: true });
  if (existsSync(executionPath)) await copyFile(executionPath, sessionOutputPath(root, `runtime/setup/backups/execution-${Date.now()}.json`));
  const executionTemporary = sessionOutputPath(root, `tmp/victorialogs-execution-${Date.now()}.json`);
  await writeFile(executionTemporary, JSON.stringify(execution, null, 2) + '\n');
  await rename(executionTemporary, executionPath);
  const execPath = join(root, 'docs/agents/EXEC.md');
  await safePath(execPath);
  const instructions = await readFile(execPath, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (!instructions.includes('## VictoriaLogs local')) await writeFile(execPath, instructions + '\n## VictoriaLogs local\n\n설정과 MCP 연결: [로컬 VictoriaLogs](../observability/victorialogs/README.md). `victorialogs-infrastructure`를 foreground로 실행하고 별도 세션에서 `victorialogs-check`와 실제 앱 profile을 사용한다. 종료는 `victorialogs-stop`이며 저장 데이터는 보존한다. 모든 실행은 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <id>`를 사용한다. Spring Boot 개발 profile 연결은 설치된 `victorialogs-local-setup` 스킬이 기존 source/config에 맞춰 완료한다.\n');
  if (!instructions.includes('## Diagnostic log v1')) await writeFile(execPath, await readFile(execPath, 'utf8') + '\n## Diagnostic log v1\n\n[진단 로그 v1 계약](../observability/victorialogs/diagnostic-log-schema.md)을 따른다. 원본 JSONL의 경로를 HARNESS_DIAGNOSTIC_LOG_FILE로 지정하고 harness-exec의 victorialogs-diagnostic-logs profile로 검사한다. Docker 없이 실행되며 실제 앱 emitter/context/redaction 및 수집 확인은 별도다.\n');
  console.log(`OpenTelemetry Collector + VictoriaLogs + VictoriaMetrics and two official MCP servers prepared (${scrapeConfig(config).scrape_configs.length} scrape targets); connect development profiles with victorialogs-local-setup. No servers started.`);
}
async function main() {
  if (action === 'setup') return setupVictoriaLogs();
  if (action === 'validate-logs') return validateLogFile();
  const config = await readConfig();
  const primaryRoot = git(['worktree', 'list', '--porcelain']).split('\n').find((line) => line.startsWith('worktree ')).slice(9);
  const data = sessionOutputPath(primaryRoot, 'runtime/observability/victorialogs/data');
  const state = sessionOutputPath(primaryRoot, 'runtime/observability/victorialogs/otel-collector');
  const metricsData = sessionOutputPath(primaryRoot, 'runtime/observability/victoriametrics/data');
  for (const path of [data, state, metricsData]) await mkdir(path, { recursive: true });
  const env = { ...process.env, HARNESS_VL_PROJECT: project, HARNESS_VL_PORT: String(config.port), HARNESS_VL_RETENTION_DAYS: String(config.retention_days), HARNESS_VL_DATA_DIR: data, HARNESS_VL_STATE_DIR: state, HARNESS_VM_PORT: String(config.metrics_port), HARNESS_VM_RETENTION_DAYS: String(config.metrics_retention_days), HARNESS_VM_DATA_DIR: metricsData, HARNESS_OTEL_PORT: String(config.otel_port), HARNESS_OBSERVABILITY_UID: String(process.getuid?.() ?? 1000), HARNESS_OBSERVABILITY_GID: String(process.getgid?.() ?? 1000) };
  const compose = ['compose', '-f', join(directory, 'compose.yaml')];
  for (const name of ['compose.yaml', 'otel-collector.yaml', 'scrape.json']) await safePath(join(directory, name));
  if (action === 'validate') {
    if (JSON.stringify(JSON.parse(await readFile(join(directory, 'scrape.json'), 'utf8'))) !== JSON.stringify(scrapeConfig(config))) throw new Error('Scrape targets differ from config.json; run setup again before starting');
    if (!(await readFile(join(directory, 'otel-javaagent.properties'), 'utf8')).split('\n').includes(`otel.exporter.otlp.logs.endpoint=http://127.0.0.1:${config.otel_port}/v1/logs`)) throw new Error('Agent OTLP endpoint differs from config.json; run setup again before starting');
    execFileSync('docker', ['info'], { cwd: root, env, stdio: 'ignore' });
    execFileSync('docker', [...compose, 'config', '--quiet'], { cwd: root, env, stdio: 'inherit' });
    execFileSync('docker', [...compose, 'run', '--rm', '--no-deps', 'otel-collector', 'validate', '--config=/etc/otelcol-contrib/config.yaml'], { cwd: root, env, stdio: 'inherit' });
    return;
  }
  if (action === 'check') {
    for (const [path, options] of [['/health', {}], ['/select/logsql/query', { method: 'POST', body: new URLSearchParams({ query: '_time:1m', limit: '1' }) }]]) {
      const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`VictoriaLogs check failed: ${path} HTTP ${response.status}`);
      await response.body?.cancel();
    }
    const metrics = await fetch(`http://127.0.0.1:${config.metrics_port}/api/v1/query?query=1`, { signal: AbortSignal.timeout(5000) });
    if (!metrics.ok || (await metrics.json()).status !== 'success') throw new Error('VictoriaMetrics query API is not ready');
    const collector = await fetch(`http://127.0.0.1:${config.otel_port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceLogs: [] }), signal: AbortSignal.timeout(5000) });
    if (!collector.ok) throw new Error(`OpenTelemetry Collector OTLP endpoint HTTP ${collector.status}`);
    await collector.body?.cancel();
    console.log('OpenTelemetry Collector, VictoriaLogs and VictoriaMetrics APIs ready; this does not prove application ingestion');
    return;
  }
  const metricsMcp = action === 'mcp-metrics';
  const argv = action === 'mcp' || metricsMcp
    ? ['run', '--rm', '-i', '--log-driver', 'none', '--network', `${project}_default`,
      '-e', `${metricsMcp ? 'VM' : 'VL'}_INSTANCE_ENTRYPOINT=http://${metricsMcp ? 'victoriametrics:8428' : 'victorialogs:9428'}`,
      ...(metricsMcp ? ['-e', 'VM_INSTANCE_TYPE=single'] : []), '-e', 'MCP_SERVER_MODE=stdio', '-e', `MCP_DISABLED_TOOLS=${metricsMcp ? 'export,flags,metric_relabel_debug,downsampling_filters_debug,retention_filters_debug,test_rules,' : ''}documentation`,
      metricsMcp ? 'ghcr.io/victoriametrics-community/mcp-victoriametrics:v1.18.0' : 'ghcr.io/victoriametrics/mcp-victorialogs:v1.9.0']
    : [...compose, ...(action === 'start' ? ['up', '--remove-orphans', '--abort-on-container-exit'] : ['down'])];
  const child = spawn('docker', argv, { cwd: root, env, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
