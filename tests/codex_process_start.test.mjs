import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runCodexProcess } from '../.harness/src/workflow/codex-process.mjs';

test('starts Codex only after its process identity was recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-gate-'));
  try {
    const marker = join(root, 'started');
    await writeFile(join(root, 'codex'), `#!/bin/sh\nprintf started > "$MARKER"\ncat >/dev/null\n`);
    await chmod(join(root, 'codex'), 0o755);
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, MARKER: marker };
    await assert.rejects(runCodexProcess({ root, args: [], env, prompt: 'hello', onStart: async () => { throw new Error('record failed'); } }), /record failed/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const result = await runCodexProcess({ root, args: [], env, prompt: 'hello', onStart: async () => {} });
    assert.equal(result.code, 0);
    assert.equal(await readFile(marker, 'utf8'), 'started');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reports live event metadata, stderr, and signal termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-events-'));
  try {
    await writeFile(join(root, 'codex'), '#!/bin/sh\ncat >/dev/null\nprintf \'{"type":"item.started","item":{"type":"command_execution","command":"private text"}}\\n\'\nprintf \'{"type":"error","message":"upstream error"}\\n\'\nprintf "diagnostic from child\\n" >&2\nkill -TERM $$\n');
    await chmod(join(root, 'codex'), 0o755);
    const events = [], stderr = [], errors = [];
    const result = await runCodexProcess({ root, args: [], env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, prompt: 'hello', onStart: async () => {}, onEvent: (event) => events.push(event), onStderr: (chunk) => stderr.push(chunk.toString()), onCodexError: (event) => errors.push(event) });
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGTERM');
    assert.match(stderr.join(''), /diagnostic from child/);
    assert.equal(errors[0].message, 'upstream error');
    assert.ok(events.some((event) => event.event === 'codex_event' && event.item_type === 'command_execution'));
    assert.ok(events.some((event) => event.event === 'child_exited' && event.signal === 'SIGTERM'));
    assert.doesNotMatch(JSON.stringify(events), /private text/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('records a signal received by the runner and the child exit signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-signal-'));
  let runner;
  try {
    await writeFile(join(root, 'codex'), '#!/bin/sh\nexec sleep 60\n');
    await chmod(join(root, 'codex'), 0o755);
    const code = `import { appendFileSync, writeFileSync } from 'node:fs'; import { runCodexProcess } from ${JSON.stringify(new URL('../.harness/src/workflow/codex-process.mjs', import.meta.url).href)}; const result = await runCodexProcess({ root: process.env.TEST_ROOT, args: [], env: process.env, prompt: 'x', onStart: async () => writeFileSync(process.env.TEST_READY, 'ready'), onEvent: (event) => appendFileSync(process.env.TEST_EVENTS, JSON.stringify(event) + '\\n') }); console.log(JSON.stringify(result));`;
    runner = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_ROOT: root, TEST_READY: join(root, 'ready'), TEST_EVENTS: join(root, 'events') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = once(runner, 'close');
    let stdout = '';
    runner.stdout.on('data', (data) => { stdout += data; });
    const deadline = Date.now() + 5000;
    while (true) {
      try { await readFile(join(root, 'ready')); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    runner.kill('SIGTERM');
    await done;
    const result = JSON.parse(stdout);
    const events = (await readFile(join(root, 'events'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(events.some((event) => event.event === 'runner_signal' && event.signal === 'SIGTERM'));
    assert.ok(events.some((event) => event.event === 'child_exited' && event.signal === 'SIGTERM'));
  } finally { if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
