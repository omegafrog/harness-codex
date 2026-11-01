import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
