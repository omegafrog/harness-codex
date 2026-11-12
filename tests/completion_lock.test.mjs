import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockCompletionStream } from '../.harness/src/workflow/completion.mjs';

// A second gate run on the same journal would write the same sequence number, which the journal cannot repair.
test('only one completion run holds a workflow journal; a dead holder is replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'completion-lock-'));
  try {
    const journal = join(dir, 'spec-me-abc.jsonl');
    const release = await lockCompletionStream(journal);
    await assert.rejects(lockCompletionStream(journal), /Another completion run .* holds/);
    await release();
    await (await lockCompletionStream(journal))();
    // A lock left by a process that no longer exists does not block the next run.
    await mkdir(`${journal}.lock`);
    await writeFile(join(`${journal}.lock`, 'pid'), '2147483646');
    await (await lockCompletionStream(journal))();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
