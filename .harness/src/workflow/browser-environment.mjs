import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

// Browser environment for stages that drive a real Chromium (frontend-visual-review, and any stage that captures
// screenshots). It answers three questions before a worker is spawned, so an environment fault is reported once with
// its fix instead of being found by a worker that then retries:
//   1. can the role reach the network (a localhost app server and the browser's DevTools need it),
//   2. does a Chromium launch at all with a short temporary directory, and
//   3. when real browser zoom is required, is a display available and does a headed Chromium launch on it.
// Chromium puts its SingletonSocket under TMPDIR; a Unix socket path is limited to ~107 bytes, so the session's
// `.io/tmp` path of a worktree is too long. The Harness therefore gives the browser its own short directory.

export const BROWSER_TMP_PARENT = '/tmp';
export const BROWSER_TMP_PREFIX = 'hb-';
// `<tmpdir>/.org.chromium.Chromium.XXXXXX/SingletonSocket` must stay below the Unix socket limit (108 bytes with NUL).
export const MAX_BROWSER_TMPDIR_LENGTH = 48;
export const BROWSER_ENVIRONMENT_FILE = 'browser-environment.json';
const PROBE_TIMEOUT_MS = 20000;

const isExecutable = (path) => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};

function playwrightBrowsers(env) {
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH : null, join(env.HOME || homedir(), '.cache/ms-playwright'), join(env.HOME || homedir(), 'Library/Caches/ms-playwright')].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let names;
    try { names = readdirSync(root); } catch { continue; }
    const revision = (name) => Number(name.split('-').at(-1)) || 0;
    for (const name of names.filter((item) => /^chromium-\d+$/.test(item)).sort((a, b) => revision(b) - revision(a))) {
      for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) {
        if (isExecutable(join(root, name, relative))) found.push({ path: join(root, name, relative), source: 'playwright' });
      }
    }
  }
  return found;
}

// The Chromium a reviewer's Playwright or a plain browser command would use. HARNESS_BROWSER_EXECUTABLE names it explicitly.
export function findBrowserExecutable({ env = process.env } = {}) {
  if (env.HARNESS_BROWSER_EXECUTABLE) return isExecutable(env.HARNESS_BROWSER_EXECUTABLE) ? { path: env.HARNESS_BROWSER_EXECUTABLE, source: 'HARNESS_BROWSER_EXECUTABLE' } : null;
  const [playwright] = playwrightBrowsers(env);
  if (playwright) return playwright;
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
      if (isExecutable(join(directory, name))) return { path: join(directory, name), source: 'PATH' };
    }
  }
  return null;
}

// A short private directory for the browser's TMPDIR, profile and sockets. The caller removes it with removeBrowserTempDirectory.
export async function createBrowserTempDirectory({ parent = BROWSER_TMP_PARENT } = {}) {
  const path = await mkdtemp(join(parent, BROWSER_TMP_PREFIX));
  if (path.length > MAX_BROWSER_TMPDIR_LENGTH) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`Browser temporary directory is too long for Chromium sockets: ${path}`);
  }
  return path;
}

// Removes only a directory this module created: directly under the parent, with the prefix, and not a symlink.
export async function removeBrowserTempDirectory(path, { parent = BROWSER_TMP_PARENT } = {}) {
  if (typeof path !== 'string' || dirname(path) !== parent || !basename(path).startsWith(BROWSER_TMP_PREFIX)) return false;
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

// The variables a browser process (and the Playwright that launches it) gets: the short directory as every temp variable.
export function browserEnvironmentVariables(tmpdir, { display = null } = {}) {
  return { TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir, HARNESS_BROWSER_TMPDIR: tmpdir, ...(display ? { DISPLAY: display } : {}) };
}

// An X display is usable when DISPLAY is set and, for a local display, its socket exists (WSLg and Xvfb provide one).
export function displayAvailability({ env = process.env, socketDirectory = '/tmp/.X11-unix', platform = process.platform } = {}) {
  if (platform === 'darwin' || platform === 'win32') return { available: true, display: null, reason: 'native_window_system' };
  const display = env.DISPLAY;
  if (!display) return { available: false, display: null, reason: 'DISPLAY is not set' };
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
  if (local && !existsSync(join(socketDirectory, `X${local[1]}`))) return { available: false, display, reason: `DISPLAY=${display} has no X socket at ${join(socketDirectory, `X${local[1]}`)}` };
  return { available: true, display, reason: 'display_set' };
}

// Codex roles run in their profile's sandbox. workspace-write has no network unless the profile enables it; read-only has none.
export async function roleNetworkAccess({ root, profile, provider = 'codex' }) {
  if (provider !== 'codex') return { status: 'pass', detail: `${provider} subagents are not network-sandboxed by their profile` };
  const path = `.codex/agents/${profile}.toml`;
  let text;
  try { text = await readFile(join(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { status: 'fail', detail: `Agent profile ${path} is missing`, fix: `Restore the managed profile: node <harness>/bin/harness-install.mjs update --project ${root}` }; throw error; }
  const mode = /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] || 'workspace-write';
  if (mode === 'danger-full-access') return { status: 'pass', detail: `${path} runs with ${mode}` };
  const table = /^\[sandbox_workspace_write\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] || '';
  if (mode === 'workspace-write' && /^\s*network_access\s*=\s*true\s*$/m.test(table)) return { status: 'pass', detail: `${path}: workspace-write with network_access = true` };
  return {
    status: 'fail',
    detail: mode === 'workspace-write' ? `${path}: workspace-write without [sandbox_workspace_write] network_access = true; the browser and the local app server cannot use localhost` : `${path}: sandbox_mode = "${mode}" has no network access`,
    fix: `Set sandbox_mode = "workspace-write" and add "[sandbox_workspace_write]\\nnetwork_access = true" to ${path} (the managed profile has it: node <harness>/bin/harness-install.mjs update --project ${root}), then relaunch the stage in a new session.`,
  };
}

// Launches Chromium once with the given TMPDIR and asks it for its version over the DevTools pipe (no TCP port, so the
// probe does not depend on the network). A crash, a sandbox abort or no answer within the timeout is a failure.
export function probeBrowserLaunch({ executable, tmpdir, headed = false, env = process.env, display = null, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const args = [...(headed ? [] : ['--headless']), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(tmpdir, 'probe-profile')}`, '--remote-debugging-pipe', 'about:blank'];
    let child, settled = false, stderr = '', reply = '';
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch { /* already gone */ } }
      resolve({ ...outcome, stderr_tail: stderr.slice(-2000) });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no DevTools answer within ${timeoutMs} ms` }), timeoutMs);
    try {
      child = spawn(executable, args, { detached: true, env: { ...env, ...browserEnvironmentVariables(tmpdir, { display }) }, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    } catch (error) { finish({ ok: false, reason: `spawn failed: ${error.code || error.message}` }); return; }
    child.on('error', (error) => finish({ ok: false, reason: `spawn failed: ${error.code || error.message}` }));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdio[4].on('data', (chunk) => {
      reply += chunk;
      const message = reply.split('\0')[0];
      if (!reply.includes('\0')) return;
      try { const parsed = JSON.parse(message); finish(parsed.id === 1 && parsed.result ? { ok: true, product: parsed.result.product || null } : { ok: false, reason: 'unexpected DevTools reply' }); }
      catch { finish({ ok: false, reason: 'unreadable DevTools reply' }); }
    });
    child.stdio[3].on('error', () => {});
    child.stdio[3].write(`${JSON.stringify({ id: 1, method: 'Browser.getVersion' })}\0`);
    child.on('exit', (code, signal) => finish({ ok: false, reason: `browser exited before answering (${signal ? `signal ${signal}` : `exit ${code}`})` }));
  });
}

// Whether the review must apply real browser zoom (e.g. a 200% zoom acceptance criterion), which needs a headed browser.
// A headed display is a heavy requirement, so a text asks for it only explicitly:
//   1. the structured signal `requires_real_zoom: true` (or `false`): a ticket frontmatter key, a line of the frontend design
//      brief, or a field of review feedback. It is the preferred form and settles that text either way, so `false` opts a text
//      out of the phrase fallback;
//   2. otherwise a phrase that states a browser-zoom check with its scale: a zoom word next to a percentage ("200% zoom",
//      "zoom to 200%", "browser zoom at 200%", "확대 200%", "줌 200%") or the browser named with the percentage
//      ("브라우저를 200% 확대", "브라우저 200%로 확대").
// A bare "200%" or "400%", a "zoom" or "확대" without a scale ("browser zoom is out of scope", "확대 상태에서도"), reflow
// percentages, and an image or chart that magnifies ("200% 확대해서 확인") are not checks.
const PERCENT = String.raw`\d{2,3}\s*(?:%|percent\b|퍼센트)`;
const ZOOM_SIGNAL = /^[ \t]*(?:[-*][ \t]+)?[`"']?requires_real_zoom[`"']?[ \t]*:[ \t]*["']?(true|false|yes|no)["']?[ \t]*,?[ \t]*$/gim;
const ZOOM_PHRASES = [
  new RegExp(String.raw`${PERCENT}\s*(?:(?:real|browser|page)\s+)*zoom(?:ed|ing|s)?\b`, 'i'),
  new RegExp(String.raw`\bzoom(?:ed|ing|s)?(?:[ -]in)?\s*(?:level\s*)?(?:to|at|of|up\s+to|=|:)?\s*${PERCENT}`, 'i'),
  new RegExp(String.raw`\bzoom(?:ed|ing|s)?\s+(?:the\s+)?(?:browser|page)\s+(?:in\s+)?(?:to|at)\s+${PERCENT}`, 'i'),
  new RegExp(String.raw`(?:확대|줌)\s*(?:율|비율|배율|배수)?\s*(?:은|는|을|를|이|가|:|=|\()?\s*${PERCENT}`),
  new RegExp(String.raw`브라우저\s*(?:를|을|의)?\s*${PERCENT}\s*(?:로|으로)?\s*(?:확대|줌)`),
];

export function requiresRealZoom(texts) {
  let explicit = null;
  const phrased = [];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const signals = [...text.matchAll(ZOOM_SIGNAL)].map((match) => ['true', 'yes'].includes(match[1].toLowerCase()));
    if (signals.length) explicit = (explicit ?? false) || signals.some(Boolean);
    else phrased.push(text);
  }
  return explicit === true || phrased.some((text) => ZOOM_PHRASES.some((phrase) => phrase.test(text)));
}

function launchFix(executable, probe) {
  const tail = probe.stderr_tail || '';
  if (/Operation not permitted|sandbox_host_linux|EPERM/.test(tail)) return `Chromium's own sandbox is refused in this environment (${executable}). Run the stage in a session whose sandbox allows Chromium to start (a workspace-write role with network_access = true), or fix the host's user-namespace restriction; do not weaken the reviewer profile to danger-full-access.`;
  if (/SingletonSocket|socket path|ENAMETOOLONG|File name too long/i.test(tail)) return 'Chromium could not create its socket; keep the browser TMPDIR short (the Harness uses /tmp/hb-*).';
  if (/error while loading shared libraries|cannot open shared object/.test(tail)) return 'Chromium is missing system libraries: run `npx playwright install-deps chromium` (or install the distribution packages) and retry.';
  return `Verify that ${executable} starts in this session, or set HARNESS_BROWSER_EXECUTABLE to a working Chromium; install one with \`npx playwright install chromium\`.`;
}

// Runs every check and returns them all, so the user sees each failing check with its fix at once.
// On success the short browser directory is kept for the worker; on failure it is removed.
export async function browserEnvironmentPreflight({ root, profile, provider = 'codex', requireHeaded = false, env = process.env, probe = probeBrowserLaunch, parent = BROWSER_TMP_PARENT }) {
  const checks = [];
  const network = await roleNetworkAccess({ root, profile, provider });
  checks.push({ id: 'role_network_access', ...network });
  const executable = findBrowserExecutable({ env });
  let tmpdir = null;
  try { tmpdir = await createBrowserTempDirectory({ parent }); }
  catch (error) { checks.push({ id: 'browser_tmpdir', status: 'fail', detail: error.message, fix: `Make ${parent} writable for this session; Chromium needs a temporary directory path of at most ${MAX_BROWSER_TMPDIR_LENGTH} characters.` }); }
  if (tmpdir) checks.push({ id: 'browser_tmpdir', status: 'pass', detail: tmpdir });
  if (!executable) checks.push({ id: 'browser_launch', status: 'fail', detail: 'No Chromium executable was found (Playwright cache, PATH or HARNESS_BROWSER_EXECUTABLE)', fix: 'Install one with `npx playwright install chromium`, or set HARNESS_BROWSER_EXECUTABLE to a Chromium binary.' });
  else if (tmpdir) {
    const headless = await probe({ executable: executable.path, tmpdir, headed: false, env });
    checks.push(headless.ok ? { id: 'browser_launch', status: 'pass', detail: `${executable.path} (${headless.product || 'Chromium'}) started headless with TMPDIR=${tmpdir}` } : { id: 'browser_launch', status: 'fail', detail: `${executable.path} did not start headless: ${headless.reason}`, fix: launchFix(executable.path, headless), stderr_tail: headless.stderr_tail });
  }
  if (requireHeaded) {
    const display = displayAvailability({ env });
    if (!display.available) checks.push({ id: 'headed_display', status: 'fail', detail: `Real browser zoom needs a headed browser, but ${display.reason}`, fix: 'Provide an X display to the session: on WSL use WSLg (DISPLAY=:0), elsewhere start `Xvfb :99 -screen 0 1920x1080x24 &` and export DISPLAY=:99, then relaunch the stage. CSS viewport reflow or CDP page scale is not real zoom.' });
    else if (executable && tmpdir && checks.find((check) => check.id === 'browser_launch')?.status === 'pass') {
      const headed = await probe({ executable: executable.path, tmpdir, headed: true, env, display: display.display });
      checks.push(headed.ok ? { id: 'headed_display', status: 'pass', detail: `headed Chromium started on ${display.display || 'the native window system'}` } : { id: 'headed_display', status: 'fail', detail: `Headed Chromium did not start on ${display.display}: ${headed.reason}`, fix: `Check that DISPLAY=${display.display} accepts X clients from this session (\`xdpyinfo -display ${display.display}\`), or start Xvfb and export its DISPLAY.`, stderr_tail: headed.stderr_tail });
    } else checks.push({ id: 'headed_display', status: 'fail', detail: `Display ${display.display || ''} is set, but headed launch was not attempted because the headless launch failed`, fix: 'Fix the browser_launch check first.' });
  }
  const passed = checks.every((check) => check.status === 'pass');
  if (!passed && tmpdir) await removeBrowserTempDirectory(tmpdir, { parent });
  const display = requireHeaded ? displayAvailability({ env }).display : null;
  return {
    passed,
    checks,
    ...(passed ? { environment: { schema_version: 1, tmpdir, executable: executable.path, headed: requireHeaded, env: browserEnvironmentVariables(tmpdir, { display }) } } : {}),
  };
}

// Stages whose worker drives a real browser; their start runs the preflight before the worker is spawned.
export const BROWSER_STAGE_SKILLS = Object.freeze(['frontend-visual-review']);
const ZOOM_SOURCE_KINDS = new Set(['ticket', 'frontend_design_brief', 'frontend_review_feedback']);

async function zoomRequired({ root, input }) {
  const session = input.session_directory, control = input.context?.control_session_directory || session;
  const texts = [];
  for (const reference of input.input_refs || []) {
    if (!ZOOM_SOURCE_KINDS.has(reference.kind) || typeof reference.path !== 'string' || reference.path.split(/[\\/]/).includes('..')) continue;
    const base = reference.base === 'session' ? session : reference.base === 'control_session' ? control : root;
    const text = await readFile(join(base, reference.path), 'utf8').catch(() => null);
    if (text !== null) texts.push(text.slice(0, 1024 * 1024));
  }
  return requiresRealZoom(texts);
}

export class BrowserEnvironmentUnavailable extends Error {
  constructor({ executionId, stageId, checks, startCommand }) {
    const failed = checks.filter((check) => check.status !== 'pass');
    super(`Browser environment preflight failed for ${stageId}: ${failed.map((check) => check.id).join(', ')}`);
    this.name = 'BrowserEnvironmentUnavailable';
    this.code = 'ENVIRONMENT_UNAVAILABLE';
    // Passed through unchanged by the native stage CLI's error writer.
    this.explained = {
      error: this.message,
      code: 'ENVIRONMENT_UNAVAILABLE',
      status: 'blocked',
      why: `No worker was spawned and nothing was recorded: ${failed.map((check) => `${check.id}: ${check.detail}`).join('; ')}`,
      failed_checks: failed.map(({ id, detail, fix }) => ({ id, detail, fix })),
      checks: checks.map(({ id, status, detail }) => ({ id, status, detail })),
      next: [`After the fix, start the same prepared execution again: ${startCommand}`],
      user_decision: `Report each failed check and its fix to the user (${failed.map((check) => check.fix).join(' ')}) and wait until the environment is fixed; do not spawn the reviewer or retry automatically.`,
      prepared_execution_id: executionId,
    };
  }
}

// Runs the preflight for a browser stage and records the short browser directory next to the execution, where
// harness-native-command reads it. Returns null for other stages; throws BrowserEnvironmentUnavailable on failure.
export async function prepareStageBrowserEnvironment({ root, input, profile, provider, executionDirectory, startCommand, env = process.env, probe }) {
  if (!BROWSER_STAGE_SKILLS.includes(input.skill)) return null;
  const requireHeaded = await zoomRequired({ root, input });
  const preflight = await browserEnvironmentPreflight({ root, profile, provider, requireHeaded, env, ...(probe ? { probe } : {}) });
  if (!preflight.passed) throw new BrowserEnvironmentUnavailable({ executionId: input.execution_id, stageId: input.context?.stage_id || input.skill, checks: preflight.checks, startCommand });
  const { writeFile } = await import('node:fs/promises');
  const previous = await readStageBrowserEnvironment(executionDirectory);
  if (previous) await removeBrowserTempDirectory(previous.tmpdir);
  const record = { ...preflight.environment, execution_id: input.execution_id, checks: preflight.checks.map(({ id, status, detail }) => ({ id, status, detail })), created_at: new Date().toISOString() };
  await writeFile(join(executionDirectory, BROWSER_ENVIRONMENT_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { ...record, path: join(executionDirectory, BROWSER_ENVIRONMENT_FILE) };
}

export async function readStageBrowserEnvironment(executionDirectory) {
  const path = join(executionDirectory, BROWSER_ENVIRONMENT_FILE);
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Unsafe browser environment record');
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (typeof record.tmpdir !== 'string' || dirname(record.tmpdir) !== BROWSER_TMP_PARENT || !basename(record.tmpdir).startsWith(BROWSER_TMP_PREFIX)) throw new Error('Invalid browser environment record');
  return record;
}

// Removes the browser directory once the stage has ended; the record stays as evidence.
export async function releaseStageBrowserEnvironment(executionDirectory) {
  const record = await readStageBrowserEnvironment(executionDirectory).catch(() => null);
  return record ? removeBrowserTempDirectory(record.tmpdir) : false;
}

// The variables a worker's command gets from a stage record; only the directory and a well-formed DISPLAY are taken from it.
export function stageBrowserVariables(record) {
  const display = typeof record?.env?.DISPLAY === 'string' && /^[A-Za-z0-9._/-]*:\d+(?:\.\d+)?$/.test(record.env.DISPLAY) ? record.env.DISPLAY : null;
  return existsSync(record.tmpdir) ? browserEnvironmentVariables(record.tmpdir, { display }) : {};
}
