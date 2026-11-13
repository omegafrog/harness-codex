import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeImplementationCheckpoint } from '../.harness/src/workflow/stage-checkpoint.mjs';
import { PlanCheckpointStore } from '../.harness/src/wrapper/checkpoint.mjs';

test('native completion records an idempotent checkpoint and preserves recovery evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-checkpoint-'));
  try {
    const input = { workspace_root: root, execution_id: 'run-1', context: { plan_id: 'slice' } };
    const envelope = { result_ref: 'runtime/executions/run-1/result.json', result: { summary: 'done', artifacts: [{ base: 'workspace', path: 'app.js', kind: 'file' }] } };
    await writeImplementationCheckpoint({ input, status: 'completed', code: 'OK', envelope, verified: true });
    await writeImplementationCheckpoint({ input, status: 'completed', code: 'OK', envelope, verified: true });
    const store = new PlanCheckpointStore({ root, planId: 'slice' });
    let state = await store.read();
    assert.equal(state.lifecycle_evidence.stage_results.length, 1);
    assert.deepEqual(state.changed_files, ['app.js']);
    await writeImplementationCheckpoint({ input: { ...input, execution_id: 'run-2' }, status: 'blocked', code: 'INPUT_MISSING', verified: false, reason: 'missing input' });
    state = await store.read();
    assert.equal(state.blocker.summary, 'missing input');
    assert.equal(state.lifecycle_evidence.stage_results.length, 2);
    await store.close();
    await assert.rejects(writeImplementationCheckpoint({ input: { ...input, context: { ...input.context, checkpoint_path: '/tmp/foreign' } }, status: 'completed', code: 'OK', envelope, verified: true }), /checkpoint path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
