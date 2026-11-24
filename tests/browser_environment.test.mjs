import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_ENVIRONMENT_FILE, BrowserEnvironmentUnavailable, MAX_BROWSER_TMPDIR_LENGTH,
  browserEnvironmentPreflight, browserEnvironmentVariables, createBrowserTempDirectory, displayAvailability, findBrowserExecutable,
  prepareStageBrowserEnvironment, probeBrowserLaunch, readStageBrowserEnvironment, releaseStageBrowserEnvironment, removeBrowserTempDirectory,
  requiresRealZoom, roleNetworkAccess, stageBrowserVariables,
} from '../.harness/src/workflow/browser-environment.mjs';
import { writeError } from '../.harness/src/workflow/stage-cli.mjs';
import { fakeBrowser } from './support/fake-browser.mjs';

const linux = { skip: process.platform !== 'linux' && 'needs the Linux X display rules' };

// A short scratch directory: the browser directory it parents must stay under the Chromium socket limit.
async function scratch(t) {
  const directory = await mkdtemp('/tmp/hbt-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const PROFILE = (sandbox, extra = '') => `name = "frontend_visual_reviewer"\nsandbox_mode = "${sandbox}"\n${extra}\ndeveloper_instructions = """x"""\n\n[skills]\ninclude_instructions = false\n`;
const NETWORK = '\n[sandbox_workspace_write]\nnetwork_access = true\n';

async function projectWith(directory, profile) {
  const root = join(directory, 'project');
  await mkdir(join(root, '.codex/agents'), { recursive: true });
  if (profile !== undefined) await writeFile(join(root, '.codex/agents/frontend_visual_reviewer.toml'), profile);
  return root;
}

test('a role reaches the network only through workspace-write network_access or full access', async (t) => {
  const directory = await scratch(t);
  const check = async (profile) => roleNetworkAccess({ root: await projectWith(directory, profile), profile: 'frontend_visual_reviewer' });
  assert.equal((await check(PROFILE('workspace-write', NETWORK))).status, 'pass');
  assert.equal((await check(PROFILE('danger-full-access'))).status, 'pass');
  assert.equal((await check(`name = "x"\n${NETWORK}`)).status, 'pass', 'workspace-write is the default sandbox_mode');

  const without = await check(PROFILE('workspace-write'));
  assert.equal(without.status, 'fail');
  assert.match(without.detail, /workspace-write without \[sandbox_workspace_write\] network_access = true/);
  assert.match(without.fix, /network_access = true/);
  assert.equal((await check(PROFILE('workspace-write', '\n[sandbox_workspace_write]\nnetwork_access = false\n'))).status, 'fail');
  assert.equal((await check(PROFILE('workspace-write', '\n[other]\nnetwork_access = true\n'))).status, 'fail', 'only the sandbox_workspace_write table grants it');
  const readOnly = await check(PROFILE('read-only', NETWORK));
  assert.equal(readOnly.status, 'fail');
  assert.match(readOnly.detail, /sandbox_mode = "read-only" has no network access/);

  const missing = await check(undefined);
  assert.equal(missing.status, 'fail');
  assert.match(missing.fix, /harness-install\.mjs update/);
  assert.equal((await roleNetworkAccess({ root: join(directory, 'nowhere'), profile: 'x', provider: 'claude' })).status, 'pass', 'Claude subagents are not sandboxed by a Codex profile');
});

test('the browser is found by explicit path, then the Playwright cache, then PATH', async (t) => {
  const directory = await scratch(t);
  const executable = async (...parts) => { const path = join(directory, ...parts); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '#!/bin/sh\n'); await chmod(path, 0o755); return path; };
  const home = join(directory, 'home');
  await mkdir(home);
  const bare = { HOME: home, PATH: join(directory, 'empty-path') };
  assert.equal(findBrowserExecutable({ env: bare }), null);

  const explicit = await executable('explicit', 'chromium');
  assert.deepEqual(findBrowserExecutable({ env: { ...bare, HARNESS_BROWSER_EXECUTABLE: explicit } }), { path: explicit, source: 'HARNESS_BROWSER_EXECUTABLE' });
  assert.equal(findBrowserExecutable({ env: { ...bare, HARNESS_BROWSER_EXECUTABLE: join(directory, 'absent') } }), null, 'a named browser that is not executable is not replaced by another');

  const bin = join(directory, 'bin');
  await executable('bin', 'google-chrome');
  assert.deepEqual(findBrowserExecutable({ env: { ...bare, PATH: bin } }), { path: join(bin, 'google-chrome'), source: 'PATH' });

  const older = await executable('cache', 'chromium-1100', 'chrome-linux64', 'chrome');
  const newer = await executable('cache', 'chromium-1200', 'chrome-linux64', 'chrome');
  await executable('cache', 'chromium_headless_shell-1300', 'chrome-linux', 'headless_shell');
  assert.notEqual(older, newer);
  assert.deepEqual(findBrowserExecutable({ env: { ...bare, PATH: bin, PLAYWRIGHT_BROWSERS_PATH: join(directory, 'cache') } }), { path: newer, source: 'playwright' }, 'the Playwright cache wins over PATH and takes the newest revision');
  assert.equal(findBrowserExecutable({ env: { ...bare, PLAYWRIGHT_BROWSERS_PATH: '0' } }), null, 'PLAYWRIGHT_BROWSERS_PATH=0 is not a directory');
});

test('the browser directory is short and private, and only such a directory is ever removed', async (t) => {
  const directory = await scratch(t);
  const created = await createBrowserTempDirectory({ parent: directory });
  assert.match(created, new RegExp(`^${directory}/hb-[A-Za-z0-9]{6}$`));
  assert.ok(created.length <= MAX_BROWSER_TMPDIR_LENGTH);
  assert.equal((await stat(created)).mode & 0o777, 0o700);
  const byDefault = await createBrowserTempDirectory();
  assert.match(byDefault, /^\/tmp\/hb-[A-Za-z0-9]{6}$/, 'the default parent is /tmp, which is short on every host');
  assert.equal(await removeBrowserTempDirectory(byDefault), true);

  // Chromium puts a socket under it; a path past the Unix socket limit is refused and leaves nothing behind.
  const longParent = join(directory, 'p'.repeat(60));
  await mkdir(longParent);
  await assert.rejects(createBrowserTempDirectory({ parent: longParent }), /too long for Chromium sockets/);
  assert.deepEqual(await readdir(longParent), []);

  assert.equal(await removeBrowserTempDirectory(created, { parent: directory }), true);
  assert.equal(existsSync(created), false);
  assert.equal(await removeBrowserTempDirectory(created, { parent: directory }), false, 'already gone');

  const other = join(directory, 'project-data');
  await mkdir(other);
  assert.equal(await removeBrowserTempDirectory(other, { parent: directory }), false, 'a directory without the prefix is not ours');
  const elsewhere = await mkdtemp(join(directory, 'hb-'));
  assert.equal(await removeBrowserTempDirectory(elsewhere, { parent: join(directory, 'sub') }), false, 'nor is one under another parent');
  const target = join(directory, 'precious');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'data');
  await symlink(target, join(directory, 'hb-link'));
  assert.equal(await removeBrowserTempDirectory(join(directory, 'hb-link'), { parent: directory }), false, 'a symlink is never followed');
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'data');
  assert.equal(await removeBrowserTempDirectory(undefined), false);
  assert.equal(await removeBrowserTempDirectory('../hb-x'), false);
});

test('browser processes get the short directory as every temporary variable and a display only when headed', () => {
  assert.deepEqual(browserEnvironmentVariables('/tmp/hb-abc123'), { TMPDIR: '/tmp/hb-abc123', TMP: '/tmp/hb-abc123', TEMP: '/tmp/hb-abc123', HARNESS_BROWSER_TMPDIR: '/tmp/hb-abc123' });
  assert.equal(browserEnvironmentVariables('/tmp/hb-abc123', { display: ':0' }).DISPLAY, ':0');
});

test('a display is available when DISPLAY names a reachable X server', linux, async (t) => {
  const directory = await scratch(t);
  assert.equal(displayAvailability({ env: {}, socketDirectory: directory }).available, false);
  assert.match(displayAvailability({ env: {}, socketDirectory: directory }).reason, /DISPLAY is not set/);
  const missing = displayAvailability({ env: { DISPLAY: ':77' }, socketDirectory: directory });
  assert.equal(missing.available, false);
  assert.match(missing.reason, new RegExp(`DISPLAY=:77 has no X socket at ${directory}/X77`));
  await writeFile(join(directory, 'X77'), '');
  assert.deepEqual(displayAvailability({ env: { DISPLAY: ':77.0' }, socketDirectory: directory }), { available: true, display: ':77.0', reason: 'display_set' });
  assert.equal(displayAvailability({ env: { DISPLAY: 'localhost:10.0' }, socketDirectory: directory }).available, true, 'a remote display is taken as set');
  assert.equal(displayAvailability({ env: {}, platform: 'darwin' }).available, true, 'macOS and Windows have a native window system');
  assert.equal(displayAvailability({ env: {}, platform: 'win32' }).available, true);
});

test('real zoom requires an explicit browser zoom criterion', () => {
  assert.equal(requiresRealZoom(['Acceptance: no horizontal overflow at 200% browser zoom']), true);
  assert.equal(requiresRealZoom(['Acceptance: verify 200% zoom reflow']), true);
  assert.equal(requiresRealZoom(['Zoom the browser to 200% and check reflow']), true);
  assert.equal(requiresRealZoom(['Acceptance: browser zoom at 200% preserves reflow']), true);
  assert.equal(requiresRealZoom(['Acceptance: zoom to 200% preserves reflow']), true);
  assert.equal(requiresRealZoom(['브라우저를 200% 확대해도 가로 스크롤이 없다']), true);
  assert.equal(requiresRealZoom(['브라우저를 200%로 확대해도 가로 스크롤이 없다']), true);
  assert.equal(requiresRealZoom(['실제 브라우저 줌 200%에서 reflow 확인']), true);
  assert.equal(requiresRealZoom(['Browser zoom is out of scope']), false);
  assert.equal(requiresRealZoom(['브라우저 확대 검증 제외']), false);
  assert.equal(requiresRealZoom(['브라우저 확대가 요구사항이다']), false);
  assert.equal(requiresRealZoom(['Reflow at 400 %']), false);
  assert.equal(requiresRealZoom(['Revenue growth reaches 200%']), false);
  assert.equal(requiresRealZoom(['The user zooms in on the chart']), false);
  assert.equal(requiresRealZoom(['이미지를 200% 확대해서 확인']), false);
  assert.equal(requiresRealZoom(['확대 상태에서도 차트 레이블을 읽을 수 있다']), false);
  assert.equal(requiresRealZoom(['Check desktop 1440, laptop 1280 and mobile 390', 'retry keeps the draft', null, 42]), false);
  assert.equal(requiresRealZoom([]), false);
});

test('the structured requires_real_zoom signal settles a text and is preferred over phrases', () => {
  const ticket = (extra) => `---\nstatus: planned\nfrontend: true\n${extra}---\n# 채팅 화면\n\n- AC-01: 재시도 상태가 보인다\n`;
  // The flag alone asks for real zoom, in a ticket frontmatter, a brief line (plain, list item, code) or a feedback field.
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: true\n')]), true);
  assert.equal(requiresRealZoom(['# Brief\n\n- requires_real_zoom: true\n- Primary flow: send, fail, retry\n']), true);
  assert.equal(requiresRealZoom(['`requires_real_zoom`: yes']), true);
  assert.equal(requiresRealZoom(['{\n  "requires_real_zoom": true,\n  "findings": []\n}']), true);
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: TRUE\n')]), true, 'the value is case-insensitive');
  assert.equal(requiresRealZoom([ticket('')]), false, 'a ticket without the flag or a zoom phrase');
  // `false` opts that text out of the phrase fallback; another text that asks for it still wins.
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: false\n') + '- AC-02: 브라우저를 200% 확대해도 가로 스크롤이 없다\n']), false);
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: no\n') + 'Verify at 200% zoom.\n', 'Primary flow: send, fail, retry']), false);
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: false\n'), '- requires_real_zoom: true']), true);
  assert.equal(requiresRealZoom([ticket('requires_real_zoom: false\n'), 'Acceptance: zoom to 200% preserves reflow']), true, 'a text without the signal keeps the phrase rule');
  // Only a line that is the signal counts: prose about the key, an unknown value or another key does not.
  assert.equal(requiresRealZoom(['Set requires_real_zoom: true when the criterion needs the browser zoom.']), false);
  assert.equal(requiresRealZoom(['requires_real_zoom: maybe']), false);
  assert.equal(requiresRealZoom(['requires_zoom: true']), false);
});

test('only a phrase that states a browser zoom check with its scale asks for real zoom', () => {
  for (const text of ['Verify at 200% zoom', 'Zoom level: 400%', 'zoomed in to 400%', '확대 200%에서 레이아웃 유지', '브라우저 확대 200%에서도 가로 스크롤이 없다', '줌 200%']) assert.equal(requiresRealZoom([text]), true, text);
  // Isolated percentages and the zoom words without a scale, in prose that merely mentions them.
  for (const text of ['200%', '400%', 'Throughput improves by 200%', '가격이 400% 올랐다', '확대', 'zoom', 'Zoom the map to the selected region', '확대 버튼을 누르면 지도가 확대된다', 'The chart supports zoom and pan', '이미지 확대 보기']) assert.equal(requiresRealZoom([text]), false, text);
  assert.equal(requiresRealZoom(['200%', '확대', 'zoom']), false, 'bare tokens in separate texts do not add up');
});

test('a launch probe reports a working browser, a sandbox abort, a missing binary and a silent hang', async (t) => {
  const directory = await scratch(t);
  const tmp = join(directory, 'tmp');
  await mkdir(tmp);

  const ok = await fakeBrowser(directory);
  const env = { PATH: process.env.PATH };
  const passed = await probeBrowserLaunch({ executable: ok.path, tmpdir: tmp, env });
  assert.deepEqual({ ok: passed.ok, product: passed.product }, { ok: true, product: 'FakeChrome/1.0' });
  assert.deepEqual(JSON.parse((await readFile(ok.log, 'utf8')).trim()), { tmpdir: tmp, display: null, headless: true }, 'the browser got the short directory as TMPDIR, headless');
  await probeBrowserLaunch({ executable: ok.path, tmpdir: tmp, headed: true, display: ':42', env });
  assert.deepEqual((await readFile(ok.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1), { tmpdir: tmp, display: ':42', headless: false }, 'a headed probe passes the display and no --headless');

  const crash = await fakeBrowser(directory, { mode: 'crash' });
  const crashed = await probeBrowserLaunch({ executable: crash.path, tmpdir: tmp, env });
  assert.equal(crashed.ok, false);
  assert.match(crashed.reason, /browser exited before answering \(exit 133\)/);
  assert.match(crashed.stderr_tail, /sandbox_host_linux\.cc:41/);

  const missing = await probeBrowserLaunch({ executable: join(directory, 'absent'), tmpdir: tmp, env });
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: 'spawn failed: ENOENT' });

  const hang = join(directory, 'hang.cjs');
  await writeFile(hang, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(directory, 'hang.pid'))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  await chmod(hang, 0o755);
  const hung = await probeBrowserLaunch({ executable: hang, tmpdir: tmp, env, timeoutMs: 400 });
  assert.deepEqual({ ok: hung.ok, reason: hung.reason }, { ok: false, reason: 'no DevTools answer within 400 ms' });
  const pid = Number(await readFile(join(directory, 'hang.pid'), 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'a probe never leaves its browser running');
});

test('the preflight passes only when network, launch and short directory all hold, and keeps the directory for the worker', async (t) => {
  const directory = await scratch(t);
  const root = await projectWith(directory, PROFILE('workspace-write', NETWORK));
  const browser = await fakeBrowser(directory);
  const env = { PATH: directory, HOME: directory, HARNESS_BROWSER_EXECUTABLE: browser.path };
  const parent = join(directory, 'parent');
  await mkdir(parent);

  const result = await browserEnvironmentPreflight({ root, profile: 'frontend_visual_reviewer', env, parent });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.deepEqual(result.checks.map((check) => [check.id, check.status]), [['role_network_access', 'pass'], ['browser_tmpdir', 'pass'], ['browser_launch', 'pass']]);
  const { environment } = result;
  assert.match(environment.tmpdir, new RegExp(`^${parent}/hb-`));
  assert.equal(existsSync(environment.tmpdir), true, 'the worker uses this directory until the stage ends');
  assert.deepEqual({ headed: environment.headed, executable: environment.executable, schema_version: environment.schema_version }, { headed: false, executable: browser.path, schema_version: 1 });
  assert.equal(environment.env.TMPDIR, environment.tmpdir);
  assert.equal(environment.env.DISPLAY, undefined);
  assert.equal(JSON.parse((await readFile(browser.log, 'utf8')).trim()).tmpdir, environment.tmpdir);
});

test('the preflight reports every failing check with its fix at once and removes the directory', async (t) => {
  const directory = await scratch(t);
  const root = await projectWith(directory, PROFILE('workspace-write'));
  const crash = await fakeBrowser(directory, { mode: 'crash' });
  const parent = join(directory, 'parent');
  await mkdir(parent);

  const result = await browserEnvironmentPreflight({ root, profile: 'frontend_visual_reviewer', env: { PATH: directory, HOME: directory, HARNESS_BROWSER_EXECUTABLE: crash.path }, parent });
  assert.equal(result.passed, false);
  assert.equal(result.environment, undefined);
  const failed = Object.fromEntries(result.checks.filter((check) => check.status === 'fail').map((check) => [check.id, check]));
  assert.deepEqual(Object.keys(failed).sort(), ['browser_launch', 'role_network_access']);
  assert.match(failed.role_network_access.fix, /network_access = true/);
  assert.match(failed.browser_launch.detail, /did not start headless: browser exited before answering/);
  assert.match(failed.browser_launch.fix, /sandbox is refused/);
  assert.match(failed.browser_launch.fix, /do not weaken the reviewer profile to danger-full-access/);
  assert.deepEqual(await readdir(parent), [], 'a failed preflight leaves no browser directory');

  const absent = await browserEnvironmentPreflight({ root, profile: 'frontend_visual_reviewer', env: { PATH: directory, HOME: directory }, parent });
  const launch = absent.checks.find((check) => check.id === 'browser_launch');
  assert.equal(launch.status, 'fail');
  assert.match(launch.detail, /No Chromium executable was found/);
  assert.match(launch.fix, /playwright install chromium/);
  assert.match(launch.fix, /HARNESS_BROWSER_EXECUTABLE/);
});

test('a missing browser library or socket error gets its own fix', async (t) => {
  const directory = await scratch(t);
  const root = await projectWith(directory, PROFILE('workspace-write', NETWORK));
  const parent = join(directory, 'parent');
  await mkdir(parent);
  const failing = (stderr_tail) => async () => ({ ok: false, reason: 'browser exited before answering (exit 127)', stderr_tail });
  const launchFix = async (stderr_tail) => (await browserEnvironmentPreflight({ root, profile: 'frontend_visual_reviewer', env: { HARNESS_BROWSER_EXECUTABLE: process.execPath }, parent, probe: failing(stderr_tail) })).checks.find((check) => check.id === 'browser_launch').fix;
  assert.match(await launchFix('error while loading shared libraries: libnss3.so'), /playwright install-deps chromium/);
  assert.match(await launchFix('Failed to create SingletonSocket: File name too long'), /short.*\/tmp\/hb-/);
  assert.match(await launchFix('something else'), /HARNESS_BROWSER_EXECUTABLE/);
});

test('real zoom also needs a display and a Chromium that launches headed on it', linux, async (t) => {
  const directory = await scratch(t);
  const root = await projectWith(directory, PROFILE('workspace-write', NETWORK));
  const parent = join(directory, 'parent');
  await mkdir(parent);
  const base = { PATH: directory, HOME: directory };
  const run = (browser, env = {}) => browserEnvironmentPreflight({ root, profile: 'frontend_visual_reviewer', requireHeaded: true, env: { ...base, HARNESS_BROWSER_EXECUTABLE: browser.path, ...env }, parent });

  const ok = await fakeBrowser(directory);
  const noDisplay = await run(ok);
  assert.equal(noDisplay.passed, false);
  const display = noDisplay.checks.find((check) => check.id === 'headed_display');
  assert.match(display.detail, /Real browser zoom needs a headed browser, but DISPLAY is not set/);
  assert.match(display.fix, /WSLg/);
  assert.match(display.fix, /Xvfb/);
  assert.match(display.fix, /not real zoom/);
  assert.equal(noDisplay.checks.find((check) => check.id === 'browser_launch').status, 'pass', 'the headless launch is reported independently');
  assert.deepEqual(await readdir(parent), []);

  const passed = await run(ok, { DISPLAY: 'localhost:10.0' });
  assert.equal(passed.passed, true, JSON.stringify(passed.checks));
  assert.equal(passed.environment.headed, true);
  assert.equal(passed.environment.env.DISPLAY, 'localhost:10.0');
  const launches = (await readFile(ok.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(launches.slice(-2).map((launch) => launch.headless), [true, false], 'one headless launch, then one headed');
  assert.equal(launches.at(-1).display, 'localhost:10.0', 'the headed launch gets the display');
  await removeBrowserTempDirectory(passed.environment.tmpdir, { parent });

  const headedCrash = await fakeBrowser(directory, { mode: 'ok', headedMode: 'crash' });
  const refused = await run(headedCrash, { DISPLAY: 'localhost:10.0' });
  assert.equal(refused.passed, false);
  assert.equal(refused.checks.find((check) => check.id === 'browser_launch').status, 'pass');
  const headed = refused.checks.find((check) => check.id === 'headed_display');
  assert.match(headed.detail, /Headed Chromium did not start on localhost:10\.0/);
  assert.match(headed.fix, /xdpyinfo -display localhost:10\.0/);

  const headlessCrash = await fakeBrowser(directory, { mode: 'crash' });
  const skipped = await run(headlessCrash, { DISPLAY: 'localhost:10.0' });
  assert.match(skipped.checks.find((check) => check.id === 'headed_display').detail, /headed launch was not attempted because the headless launch failed/);
  assert.equal((await readFile(headlessCrash.log, 'utf8')).trim().split('\n').length, 1, 'no headed attempt after a headless failure');
  assert.deepEqual(await readdir(parent), []);
});

// The stage-start wiring: the browser stage records a short directory next to its execution, other stages do nothing.
async function stageFixture(t, { ticket = 'Show the retry state.\n', brief } = {}) {
  const directory = await scratch(t);
  const root = await projectWith(directory, PROFILE('workspace-write', NETWORK));
  const session = join(root, '.io');
  const executionDirectory = join(session, 'runtime/executions/frontend-visual-review-1');
  await mkdir(executionDirectory, { recursive: true });
  await mkdir(join(root, 'docs/plans/x'), { recursive: true });
  await writeFile(join(root, 'docs/plans/x/ui.md'), ticket);
  if (brief !== undefined) await writeFile(join(session, 'brief.md'), brief);
  const input = { skill: 'frontend-visual-review', execution_id: 'frontend-visual-review-1', session_directory: session, context: { stage_id: 'frontend-visual-review' }, input_refs: [{ base: 'workspace', path: 'docs/plans/x/ui.md', kind: 'ticket' }, ...(brief === undefined ? [] : [{ base: 'session', path: 'brief.md', kind: 'frontend_design_brief' }])] };
  const probed = [];
  const probe = async (options) => { probed.push(options); return { ok: true, product: 'Stub/1.0' }; };
  // The browser directories live in /tmp, outside the scratch directory: remove each one this fixture made, whatever the hooks' order.
  const made = [];
  const prepare = async (overrides = {}) => {
    const record = await prepareStageBrowserEnvironment({ root, input, profile: 'frontend_visual_reviewer', provider: 'codex', executionDirectory, startCommand: 'node .harness/scripts/harness-native-stage.mjs start --execution-id frontend-visual-review-1', env: { HARNESS_BROWSER_EXECUTABLE: process.execPath, HOME: directory, PATH: directory }, probe, ...overrides });
    if (record) made.push(record.tmpdir);
    return record;
  };
  t.after(() => Promise.all(made.map((path) => removeBrowserTempDirectory(path))));
  return { directory, root, input, executionDirectory, prepare, probed };
}

test('a stage start records a short browser directory that the worker commands and the stage end use', async (t) => {
  const { executionDirectory, prepare, probed, input } = await stageFixture(t);
  const record = await prepare();
  assert.equal(record.path, join(executionDirectory, BROWSER_ENVIRONMENT_FILE));
  assert.match(record.tmpdir, /^\/tmp\/hb-[A-Za-z0-9]{6}$/);
  assert.ok(record.tmpdir.length <= MAX_BROWSER_TMPDIR_LENGTH);
  assert.equal(record.headed, false);
  assert.equal(record.execution_id, input.execution_id);
  assert.deepEqual(record.checks.map((check) => check.id), ['role_network_access', 'browser_tmpdir', 'browser_launch']);
  assert.equal((await lstat(record.path)).mode & 0o777, 0o600);
  assert.deepEqual(probed.map(({ headed, tmpdir }) => [headed, tmpdir]), [[false, record.tmpdir]]);

  const stored = await readStageBrowserEnvironment(executionDirectory);
  assert.equal(stored.tmpdir, record.tmpdir);
  assert.deepEqual(stageBrowserVariables(stored), { TMPDIR: record.tmpdir, TMP: record.tmpdir, TEMP: record.tmpdir, HARNESS_BROWSER_TMPDIR: record.tmpdir });

  // Starting the same execution again replaces the earlier directory instead of leaking it.
  const again = await prepare();
  assert.notEqual(again.tmpdir, record.tmpdir);
  assert.equal(existsSync(record.tmpdir), false);
  assert.equal(existsSync(again.tmpdir), true);

  assert.equal(await releaseStageBrowserEnvironment(executionDirectory), true);
  assert.equal(existsSync(again.tmpdir), false, 'the directory goes when the stage ends');
  assert.equal((await readStageBrowserEnvironment(executionDirectory)).tmpdir, again.tmpdir, 'the record stays as evidence');
  assert.equal(await releaseStageBrowserEnvironment(executionDirectory), false);
  assert.deepEqual(stageBrowserVariables(await readStageBrowserEnvironment(executionDirectory)), {}, 'a directory that is gone gives no variables');
});

test('only the browser stage runs the preflight and records nothing for another stage', async (t) => {
  const { executionDirectory, input, prepare, probed } = await stageFixture(t);
  assert.equal(await prepare({ input: { ...input, skill: 'frontend-implement' } }), null);
  assert.deepEqual(probed, []);
  assert.equal(existsSync(join(executionDirectory, BROWSER_ENVIRONMENT_FILE)), false);
  assert.equal(await readStageBrowserEnvironment(executionDirectory), null);
  assert.equal(await releaseStageBrowserEnvironment(executionDirectory), false);
});

test('a zoom criterion in the ticket, brief or feedback makes the review headed', linux, async (t) => {
  const env = (display) => ({ HARNESS_BROWSER_EXECUTABLE: process.execPath, HOME: '/nonexistent', PATH: '/nonexistent', ...(display ? { DISPLAY: display } : {}) });
  const ticketed = await stageFixture(t, { ticket: '- AC-03: 브라우저 200% 확대에서 가로 스크롤이 없다\n' });
  await assert.rejects(ticketed.prepare({ env: env() }), (error) => error instanceof BrowserEnvironmentUnavailable && error.explained.failed_checks.some((check) => check.id === 'headed_display'));
  assert.equal(existsSync(join(ticketed.executionDirectory, BROWSER_ENVIRONMENT_FILE)), false, 'a refused start records nothing');
  ticketed.probed.length = 0;
  const headed = await ticketed.prepare({ env: env('localhost:10.0') });
  assert.equal(headed.headed, true);
  assert.equal(headed.env.DISPLAY, 'localhost:10.0');
  assert.deepEqual(ticketed.probed.map((probe) => probe.headed), [false, true]);
  assert.deepEqual(stageBrowserVariables(await readStageBrowserEnvironment(ticketed.executionDirectory)).DISPLAY, 'localhost:10.0');

  const briefed = await stageFixture(t, { brief: 'Verify browser zoom at 200%.\n' });
  await assert.rejects(briefed.prepare({ env: env() }), /headed_display/);
  const plain = await stageFixture(t, { ticket: 'Show the retry state.\n', brief: 'Primary flow: send, fail, retry.\n' });
  assert.equal((await plain.prepare({ env: env() })).headed, false, 'no zoom criterion, no display needed');

  // Only declared sources are read: another kind or a path that leaves its base is not.
  const other = await stageFixture(t);
  other.input.input_refs.push({ base: 'workspace', path: 'docs/plans/x/ui.md', kind: 'other' }, { base: 'session', path: '../escape.md', kind: 'ticket' });
  await writeFile(join(other.root, 'escape.md'), 'zoom 200%');
  assert.equal((await other.prepare({ env: env() })).headed, false);
});

test('a stage start asks for a display only for the explicit flag or a scaled zoom phrase', linux, async (t) => {
  const env = (display) => ({ HARNESS_BROWSER_EXECUTABLE: process.execPath, HOME: '/nonexistent', PATH: '/nonexistent', ...(display ? { DISPLAY: display } : {}) });
  const frontmatter = (extra) => `---\nstatus: planned\nfrontend: true\n${extra}---\n# 화면\n\n`;
  // The ticket flag requires a headed display even when no zoom phrase is written.
  const flagged = await stageFixture(t, { ticket: `${frontmatter('requires_real_zoom: true\n')}- AC-01: 가로 스크롤이 없다\n` });
  await assert.rejects(flagged.prepare({ env: env() }), (error) => error instanceof BrowserEnvironmentUnavailable && error.explained.failed_checks.some((check) => check.id === 'headed_display'));
  assert.equal((await flagged.prepare({ env: env('localhost:10.0') })).headed, true);
  // The brief carries the same flag.
  const briefed = await stageFixture(t, { brief: '# Design brief\n\n- requires_real_zoom: true\n' });
  await assert.rejects(briefed.prepare({ env: env() }), /headed_display/);
  // Words that only mention zoom, percentages or magnification start a headless review without any display.
  const mentions = await stageFixture(t, { ticket: `${frontmatter('')}- AC-01: 처리량이 200% 증가한다\n- AC-02: 차트를 확대할 수 있다\n- AC-03: Zoom the map to the selected region; 400% is the upper bound of the price filter\n`, brief: 'Primary flow: send, fail, retry. 확대 상태에서도 레이블을 읽는다.\n' });
  const record = await mentions.prepare({ env: env() });
  assert.equal(record.headed, false);
  assert.deepEqual(mentions.probed.map((probe) => probe.headed), [false], 'no headed probe and no display needed');
  // The flag set to false lets a ticket quote a zoom phrase without asking for the display.
  const declined = await stageFixture(t, { ticket: `${frontmatter('requires_real_zoom: false\n')}- AC-01: 브라우저를 200% 확대한 모양은 정적 CSS로 대신 확인한다\n` });
  assert.equal((await declined.prepare({ env: env() })).headed, false);
  // A flag in review feedback (the previous visual review's result) asks for it as well.
  const feedback = await stageFixture(t);
  await writeFile(join(feedback.root, '.io/feedback.json'), JSON.stringify({ requires_real_zoom: true, findings: [] }, null, 2));
  feedback.input.input_refs.push({ base: 'session', path: 'feedback.json', kind: 'frontend_review_feedback' });
  await assert.rejects(feedback.prepare({ env: env() }), /headed_display/);
});

test('a refused browser start is ENVIRONMENT_UNAVAILABLE with each fix, passed through the CLI error writer unchanged', async (t) => {
  const { root, executionDirectory, prepare, probed } = await stageFixture(t);
  await writeFile(join(root, '.codex/agents/frontend_visual_reviewer.toml'), PROFILE('workspace-write'));
  const failing = async (options) => { probed.push(options); return { ok: false, reason: 'browser exited before answering (signal SIGTRAP)', stderr_tail: 'sandbox_host_linux.cc Operation not permitted' }; };
  const error = await prepare({ probe: failing }).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof BrowserEnvironmentUnavailable);
  assert.equal(error.code, 'ENVIRONMENT_UNAVAILABLE');
  assert.match(error.message, /Browser environment preflight failed for frontend-visual-review: role_network_access, browser_launch/);
  assert.equal(existsSync(probed[0].tmpdir), false, 'the directory made for the probe is removed');
  assert.equal(existsSync(join(executionDirectory, BROWSER_ENVIRONMENT_FILE)), false);

  let written = '';
  writeError({ write: (text) => { written += text; } }, error, { stageId: 'frontend-visual-review' });
  const payload = JSON.parse(written);
  assert.deepEqual(Object.keys(payload).sort(), ['checks', 'code', 'error', 'failed_checks', 'next', 'prepared_execution_id', 'status', 'user_decision', 'why']);
  assert.equal(payload.code, 'ENVIRONMENT_UNAVAILABLE');
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.prepared_execution_id, 'frontend-visual-review-1');
  assert.deepEqual(payload.failed_checks.map((check) => check.id), ['role_network_access', 'browser_launch']);
  assert.ok(payload.failed_checks.every((check) => check.fix), 'every failed check names its concrete fix');
  assert.deepEqual(payload.checks.map((check) => check.id), ['role_network_access', 'browser_tmpdir', 'browser_launch']);
  assert.match(payload.why, /No worker was spawned and nothing was recorded/);
  assert.equal(payload.next.length, 1);
  assert.match(payload.next[0], /harness-native-stage\.mjs start --execution-id frontend-visual-review-1$/);
  assert.match(payload.user_decision, /do not spawn the reviewer or retry automatically/);
  assert.match(payload.user_decision, /network_access = true/);
});

test('a stored browser record that is not ours is refused', async (t) => {
  const directory = await scratch(t);
  const record = join(directory, BROWSER_ENVIRONMENT_FILE);
  assert.equal(await readStageBrowserEnvironment(directory), null);
  await writeFile(record, JSON.stringify({ tmpdir: '/etc' }));
  await assert.rejects(readStageBrowserEnvironment(directory), /Invalid browser environment record/);
  await writeFile(record, JSON.stringify({ tmpdir: '/tmp/hb-abc123/../../etc' }));
  await assert.rejects(readStageBrowserEnvironment(directory), /Invalid browser environment record/);
  assert.equal(await releaseStageBrowserEnvironment(directory), false, 'releasing never removes what the record points outside /tmp/hb-*');
  await rm(record);
  await writeFile(join(directory, 'real.json'), JSON.stringify({ tmpdir: '/tmp/hb-abc123' }));
  await symlink(join(directory, 'real.json'), record);
  await assert.rejects(readStageBrowserEnvironment(directory), /Unsafe browser environment record/);

  assert.deepEqual(stageBrowserVariables({ tmpdir: directory, env: { DISPLAY: '$(touch pwned):0' } }), browserEnvironmentVariables(directory), 'a malformed DISPLAY is dropped');
  assert.equal(stageBrowserVariables({ tmpdir: directory, env: { DISPLAY: ':99.1' } }).DISPLAY, ':99.1');
});

// A key after a [table] header belongs to that table: the role's instructions must stay at the root of the profile.
test('every managed Codex agent profile keeps its root keys ahead of its tables', async () => {
  const directory = join(import.meta.dirname, '../.codex/agents');
  const profiles = (await readdir(directory)).filter((name) => name.endsWith('.toml'));
  assert.ok(profiles.includes('frontend_visual_reviewer.toml'));
  for (const name of profiles) {
    const text = (await readFile(join(directory, name), 'utf8')).replace(/"""[\s\S]*?"""/g, '""""""');
    const firstTable = /^\[/m.exec(text)?.index ?? Infinity;
    for (const key of ['name', 'description', 'sandbox_mode', 'developer_instructions']) {
      const at = new RegExp(`^${key} = `, 'm').exec(text)?.index;
      assert.ok(at !== undefined && at < firstTable, `${name}: ${key} must be a root key, before any [table]`);
    }
  }
  assert.equal((await roleNetworkAccess({ root: join(import.meta.dirname, '..'), profile: 'frontend_visual_reviewer' })).status, 'pass', 'the shipped reviewer profile has network access');
});
