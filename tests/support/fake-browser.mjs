import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A stand-in Chromium for browser preflight tests: it answers Browser.getVersion on the DevTools pipe (fd 3 in, fd 4 out)
// like the real one, or aborts like a sandbox-refused Chromium, and logs each launch's TMPDIR, DISPLAY and headless flag.
export async function fakeBrowser(directory, { mode = 'ok', headedMode = mode } = {}) {
  const path = join(directory, `fake-chromium-${mode}-${headedMode}.cjs`);
  const log = `${path}.log`;
  await writeFile(path, `#!${process.execPath}
const fs = require('node:fs');
const headless = process.argv.includes('--headless');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tmpdir: process.env.TMPDIR, display: process.env.DISPLAY || null, headless }) + '\\n');
const mode = headless ? ${JSON.stringify(mode)} : ${JSON.stringify(headedMode)};
if (mode === 'crash') { process.stderr.write('[FATAL:content/browser/sandbox_host_linux.cc:41] Check failed: . shutdown: Operation not permitted (1)\\n'); process.exit(133); }
const input = fs.createReadStream(null, { fd: 3 });
let text = '';
input.on('data', (chunk) => {
  text += chunk;
  if (!text.includes('\\0')) return;
  const request = JSON.parse(text.split('\\0')[0]);
  fs.writeSync(4, JSON.stringify({ id: request.id, result: { product: 'FakeChrome/1.0' } }) + '\\0');
});
setInterval(() => {}, 1000);
`);
  await chmod(path, 0o755);
  return { path, log };
}
