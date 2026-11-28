#!/usr/bin/env node
// Renders each visual style candidate's static mock in Chromium (Playwright), captures desktop and requested mobile screenshots into
// the execution's session output and writes one comparison page. Prints the `previews` and comparison path for the
// frontend-design-brief visual_direction question.
//
// Layout (session-relative): runtime/executions/<execution_id>/style-options/
//   options.json            {"screen": "<key screen>", "options": [{"id", "label", "summary"}]}   (written by the designer)
//   <option_id>/mock.html   self-contained static mock of the same key screen in that style      (written by the designer)
//   <option_id>/<viewport>.png, index.html                                                        (written by this script)
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const installed = new URL('../../../../.harness/src/workflow/session-output.mjs', import.meta.url);
const { sessionDirectory, sessionOutputPath } = await import(installed.href);

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Chromium puts its SingletonSocket under TMPDIR; a Unix socket path over ~107 bytes fails, and a worktree session
// TMPDIR (<worktree>/.io/tmp) is often longer than that. Only Chromium's own temp directory moves to a short path.
const SOCKET_BUDGET = 60;

const USAGE = "Usage: capture-style-options.mjs --root <workspace_root> --execution-id <execution_id> [--browser-path <chromium>] (default: HARNESS_BROWSER_EXECUTABLE, else Playwright's own Chromium)";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !['root', 'execution-id', 'browser-path'].includes(key) || !argv[index + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${argv[index]}`);
    options[key] = argv[index + 1];
  }
  if (!options.root || !options['execution-id']) throw new Error(USAGE);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options['execution-id'])) throw new Error('Invalid execution ID');
  return { root: resolve(options.root), executionId: options['execution-id'], browserPath: options['browser-path'] || process.env.HARNESS_BROWSER_EXECUTABLE || null };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function regularFile(path, what) {
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') throw new Error(`${what} is missing: ${path}`); throw error; });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${what} must be a regular file: ${path}`);
}

export async function readStyleOptions(root, executionId) {
  const directory = `runtime/executions/${executionId}/style-options`;
  const manifestPath = sessionOutputPath(root, `${directory}/options.json`);
  await regularFile(manifestPath, 'Style option manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest.screen !== 'string' || !manifest.screen.trim() || !Array.isArray(manifest.options) || manifest.options.length < 2) throw new Error('options.json needs a screen and at least two options');
  if (manifest.viewports !== undefined && (!Array.isArray(manifest.viewports) || !manifest.viewports.includes('desktop') || manifest.viewports.some((name) => !Object.hasOwn(VIEWPORTS, name)) || new Set(manifest.viewports).size !== manifest.viewports.length)) throw new Error('viewports must contain desktop and may contain mobile');
  const ids = new Set();
  for (const option of manifest.options) {
    if (!OPTION_ID.test(option?.id || '') || ids.has(option.id) || typeof option.label !== 'string' || !option.label.trim() || typeof option.summary !== 'string') throw new Error(`Invalid or duplicate style option: ${JSON.stringify(option?.id)}`);
    ids.add(option.id);
    const mock = sessionOutputPath(root, `${directory}/${option.id}/mock.html`);
    await regularFile(mock, `Mock of option ${option.id}`);
    // Without a device-width viewport a mobile browser lays the mock out at 980px, so the mobile sample would be a desktop page.
    if (!/<meta[^>]+name=["']?viewport["']?[^>]*width=device-width/i.test(await readFile(mock, 'utf8'))) throw new Error(`Mock of option ${option.id} needs <meta name="viewport" content="width=device-width, initial-scale=1">`);
  }
  return { directory, manifest };
}

// The project's own Playwright first, then a global install. Nothing is installed by this script.
async function loadChromium(root) {
  const candidates = [];
  for (const base of [join(root, 'package.json'), import.meta.url]) for (const name of ['playwright', 'playwright-core', '@playwright/test']) candidates.push(() => createRequire(base).resolve(name));
  for (const name of ['playwright', 'playwright-core']) candidates.push(() => {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return createRequire(join(globalRoot, 'noop.js')).resolve(name);
  });
  for (const candidate of candidates) {
    let path;
    try { path = candidate(); } catch { continue; }
    const module = await import(pathToFileURL(path).href);
    const chromium = module.chromium || module.default?.chromium;
    if (chromium) return chromium;
  }
  throw Object.assign(new Error('Playwright is not available in the project or globally; report ENVIRONMENT_UNAVAILABLE instead of choosing a style alone'), { code: 'PLAYWRIGHT_UNAVAILABLE' });
}

function comparisonPage(manifest, previews) {
  const columns = manifest.options.map((option) => `<section class="option" aria-labelledby="o-${option.id}">
  <h2 id="o-${option.id}">${escapeHtml(option.label)} <code>${option.id}</code></h2>
  ${option.summary ? `<p>${escapeHtml(option.summary)}</p>` : ''}
  ${previews[option.id].map((item) => `<figure class="${item.viewport}"><a href="${option.id}/${item.viewport}.png"><img src="${option.id}/${item.viewport}.png" alt="${escapeHtml(item.caption)}" loading="lazy"></a><figcaption>${escapeHtml(item.caption)}</figcaption></figure>`).join('\n  ')}
</section>`).join('\n');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>스타일 후보 비교</title>
<style>
:root { color-scheme: light; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #5c5c57; --line: #d8d8d2; --surface: #ffffff; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
header p { margin: 0 0 20px; color: var(--muted); }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); }
.option { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; min-width: 0; }
.option h2 { font-size: 17px; margin: 0 0 6px; }
.option code { font-size: 12px; color: var(--muted); }
.option p { margin: 0 0 12px; color: var(--muted); }
figure { margin: 0 0 12px; }
figure.mobile img { max-width: 220px; }
img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; }
</style>
</head>
<body>
<header><h1>스타일 후보 비교 — ${escapeHtml(manifest.screen)}</h1><p>같은 핵심 화면을 후보별 스타일로 렌더링한 정적 시안입니다. 이미지를 누르면 원본 크기로 열립니다.</p></header>
<main class="grid">
${columns}
</main>
</body>
</html>
`;
}

export async function captureStyleOptions({ root, executionId, browserPath = null, chromium = null }) {
  const session = sessionDirectory(root);
  const { directory, manifest } = await readStyleOptions(root, executionId);
  chromium ??= await loadChromium(root);
  const sessionTmp = join(session, 'tmp');
  await mkdir(sessionTmp, { recursive: true, mode: 0o700 });
  const tempBase = sessionTmp.length <= SOCKET_BUDGET ? sessionTmp : '/tmp';
  const chromiumTmp = await mkdtemp(join(tempBase, 'hfd-'));
  const saved = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) process.env[key] = chromiumTmp;
  const previews = {};
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}), env: { ...process.env } });
    for (const option of manifest.options) {
      previews[option.id] = [];
      const mock = pathToFileURL(sessionOutputPath(root, `${directory}/${option.id}/mock.html`)).href;
      for (const viewport of manifest.viewports || ['desktop']) {
        const settings = VIEWPORTS[viewport];
        const context = await browser.newContext({ ...settings, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        try {
          const page = await context.newPage();
          // Mocks are self-contained: no network, so the samples are reproducible and need no access.
          await page.route('**/*', (route) => (/^(file|data|about|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
          await page.goto(mock, { waitUntil: 'load' });
          const path = `${directory}/${option.id}/${viewport}.png`;
          await page.screenshot({ path: sessionOutputPath(root, path), fullPage: true, animations: 'disabled' });
          previews[option.id].push({ path, viewport, caption: `${option.label} — ${viewport === 'desktop' ? '데스크톱' : '모바일'} ${settings.viewport.width}px` });
        } finally { await context.close(); }
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(chromiumTmp, { recursive: true, force: true });
  }
  const page = `${directory}/index.html`;
  await writeFile(sessionOutputPath(root, page), comparisonPage(manifest, previews), { mode: 0o600 });
  return {
    comparison_page: { path: page, absolute_path: join(session, page) },
    options: manifest.options.map((option) => ({ id: option.id, label: option.label, previews: previews[option.id], absolute_paths: previews[option.id].map((item) => join(session, item.path)) })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (['--help', '-h'].includes(process.argv[2])) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  try {
    process.stdout.write(`${JSON.stringify(await captureStyleOptions(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code || null })}\n`);
    process.exitCode = error.code === 'PLAYWRIGHT_UNAVAILABLE' ? 2 : 1;
  }
}
