import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A Codex run that stops writing is stopped by the watchdog instead of keeping the stage alive for hours.
test('a Codex process that writes nothing is stopped and reported as stalled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stall-'));
  try {
    await writeFile(join(dir, 'codex'), '#!/bin/sh\necho \'{"type":"thread.started","thread_id":"01a1c32f-5b35-7621-a111-30139430f026"}\'\nexec sleep 30\n');
    await chmod(join(dir, 'codex'), 0o755);
    process.env.HARNESS_STAGE_STALL_MS = '1500';
    process.env.HARNESS_STAGE_STALL_CHECK_MS = '200';
    const { runCodexProcess } = await import(`../.harness/src/workflow/codex-process.mjs?stall=${Date.now()}`);
    const events = [];
    const started = Date.now();
    const result = await runCodexProcess({ root: dir, args: [], env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, prompt: 'x', onStart: async () => {}, onEvent: (event) => events.push(event.event) });
    assert.equal(result.stalled, true);
    assert.ok(Date.now() - started < 15000, 'stopped long before the 30 second sleep ended');
    assert.ok(events.includes('stage_stalled'));
    assert.equal(result.threadId, '01a1c32f-5b35-7621-a111-30139430f026');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
