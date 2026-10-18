import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const sourceRoot = new URL('..', import.meta.url).pathname;
const session = (await execFileAsync('node', ['.codex/scripts/harness-session-output.mjs', '--root', sourceRoot, '--path', 'tmp'], { cwd: sourceRoot })).stdout.trim();
const cli = join(sourceRoot, '.codex/scripts/harness-exec.mjs');

async function fixture(t) {
  const root = await mkdtemp(join(session, 'execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'settings.json'), '{"port":4312}\n');
  return root;
}
function profile(overrides = {}) {
  return { command: ['node', 'main.mjs', '--port', '${PORT}'], required_env: ['PORT'], config_inputs: ['settings.json'], prepare: [], verify_config: [['node', 'verify.mjs']], dependencies: [], timeout_ms: 3000, readiness_timeout_ms: 500, poll_interval_ms: 10, ...overrides };
}
async function run(root, env = {}, launcher = cli) {
  try {
    const result = await execFileAsync('node', [launcher, '--root', root, '--profile', 'test'], { cwd: root, env: { ...process.env, ...env }, maxBuffer: 1_000_000 });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}
async function setup(root, p) {
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { test: p } }));
}

test('blocks missing env or unresolved command variables before preparation', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'prepare.mjs'), "await import('node:fs/promises').then(fs=>fs.writeFile('prepared','yes'))");
  await setup(root, profile({ prepare: [['node', 'prepare.mjs']], command: ['node', 'main.mjs', '${MISSING}'] }));
  assert.equal((await run(root, { PORT: '' })).status, 'blocked');
  const result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'load');
  await assert.rejects(readFile(join(root, 'prepared')));

  await setup(root, profile({ config_inputs: ['../outside.json'], prepare: [['node', 'prepare.mjs']] }));
  assert.equal((await run(root, { PORT: '4312' })).status, 'blocked');
  await assert.rejects(readFile(join(root, 'prepared')));

  const outside = join(session, 'outside-settings.json');
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, '{"port":4312}');
  await symlink(outside, join(root, 'linked-settings.json'));
  await setup(root, profile({ config_inputs: ['linked-settings.json'], prepare: [['node', 'prepare.mjs']] }));
  const linked = await run(root, { PORT: '4312' });
  assert.equal(linked.status, 'blocked');
  await assert.rejects(readFile(join(root, 'prepared')));
});

test('prepares current config and checks effective values/readiness before literal-argv main command', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'prepare.mjs'), "const fs=await import('node:fs/promises'); await fs.writeFile('settings.json',JSON.stringify({port:process.env.PORT})); await fs.writeFile('prepared','yes')");
  await writeFile(join(root, 'verify.mjs'), "const fs=await import('node:fs/promises'); const config=JSON.parse(await fs.readFile('settings.json','utf8')); if (config.port!==process.env.PORT) process.exit(1)");
  await writeFile(join(root, 'ready.mjs'), "const fs=await import('node:fs/promises'); if ((await fs.readFile('prepared','utf8'))!=='yes') process.exit(1)");
  await writeFile(join(root, 'main.mjs'), "const fs=await import('node:fs/promises'); await fs.writeFile('args.json',JSON.stringify(process.argv.slice(2)))");
  await setup(root, profile({ required_env: ['PORT', 'LABEL'], prepare: [['node', 'prepare.mjs']], command: ['node', 'main.mjs', '--port', '${PORT}', '--label', '${LABEL}'], dependencies: [{ id: 'service', check: ['node', 'ready.mjs'] }] }));
  const label = '$(touch injected)';
  const result = await run(root, { PORT: '4313', LABEL: label });
  assert.equal(result.status, 'passed');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'args.json'), 'utf8')), ['--port', '4313', '--label', label]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')), { port: '4313' });
  assert.deepEqual(result.steps.map((step) => step.phase), ['prepare', 'verify_config', 'dependency:service', 'command']);
  assert.ok(result.evidence_path.startsWith(result.session_directory));
  await assert.rejects(readFile(join(root, 'injected')));

  const installed = join(root, '.codex');
  await mkdir(join(installed, 'scripts'), { recursive: true });
  await mkdir(join(installed, 'harness-runtime/src'), { recursive: true });
  await cp(join(sourceRoot, '.codex/scripts/harness-exec.mjs'), join(installed, 'scripts/harness-exec.mjs'));
  await cp(join(sourceRoot, 'src'), join(installed, 'harness-runtime/src'), { recursive: true });
  const installedResult = await run(root, { PORT: '4313', LABEL: label }, join(installed, 'scripts/harness-exec.mjs'));
  assert.equal(installedResult.status, 'passed');
});

test('blocks stale verification, unavailable infrastructure, config drift, and reports main failure', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'verify.mjs'), 'process.exit(1)');
  await setup(root, profile());
  let result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.steps.at(-1).phase, 'verify_config');

  await writeFile(join(root, 'verify.mjs'), 'process.exit(0)');
  await writeFile(join(root, 'no.mjs'), 'process.exit(1)');
  await setup(root, profile({ dependencies: [{ id: 'service', check: ['node', 'no.mjs'] }], readiness_timeout_ms: 50 }));
  result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'blocked');
  assert.ok(!result.steps.some((step) => step.phase === 'command'));

  await writeFile(join(root, 'drift.mjs'), "await import('node:fs/promises').then(fs=>fs.writeFile('settings.json','changed'))");
  await setup(root, profile({ dependencies: [{ id: 'service', check: ['node', 'drift.mjs'] }] }));
  result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /Configuration changed/);

  await writeFile(join(root, 'main.mjs'), 'process.exit(7)');
  await setup(root, profile());
  result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
});


test('records missing executables, timeouts, and SIGINT without leaving the main command running', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'verify.mjs'), 'process.exit(0)');
  await setup(root, profile({ command: ['harness-command-that-does-not-exist'], timeout_ms: 100 }));
  let result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'command');

  await setup(root, profile({ command: ['node', '-e', 'setInterval(()=>{},1000)'], timeout_ms: 80 }));
  result = await run(root, { PORT: '4312' });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /timed out/);

  await setup(root, profile({ command: ['node', '-e', "require('node:fs').writeFileSync('running','yes'); setInterval(()=>{},1000)"], timeout_ms: 3000 }));
  const child = spawn('node', [cli, '--root', root, '--profile', 'test'], { cwd: root, env: { ...process.env, PORT: '4312' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });
  let running = false;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { running = (await readFile(join(root, 'running'), 'utf8')) === 'yes'; } catch {}
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running, true, 'main command did not reach its running marker');
    child.kill('SIGINT');
  } finally {
    if (!child.killed) child.kill('SIGINT');
  }
  const code = await closed;
  assert.equal(code, 1);
  result = JSON.parse(stdout);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.phase, 'command');
});
