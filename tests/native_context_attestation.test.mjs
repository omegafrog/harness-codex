import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { readNativeCodexAttestation, refreshNativeCodexAttestation, verifyNativeCodexWorkerBinding } from '../.harness/src/workflow/native-context.mjs';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const agentPath = '/root/test_agent';
const turnId = '33333333-3333-4333-8333-333333333333';

const row = (type, payload, timestamp = '2026-11-22T05:23:31.400Z') => JSON.stringify({ type, payload, timestamp });

test('finish-time attestation refresh captures a child rollout completed after SubagentStop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-attestation-'));
  const codexHome = join(root, 'codex-home');
  const sessions = join(codexHome, 'sessions', '2026', '11', '22');
  const previousHome = process.env.CODEX_HOME;
  const previous = process.env.HOME;
  const parentFile = join(sessions, `rollout-parent-${parentId}.jsonl`);
  const childFile = join(sessions, `rollout-child-${childId}.jsonl`);
  const stage = { stage_id: 'frontend-design-brief', skill: 'frontend-design', execution_id: 'exec-123', native_agent_id: agentPath, started_at: '2026-11-22T05:20:00.000Z' };
  try {
    await mkdir(join(root, '.io'), { recursive: true });
    await mkdir(sessions, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    delete process.env.HOME;
    await writeFile(parentFile, [
      row('session_meta', { id: parentId, cwd: root }),
      row('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: agentPath, agent_thread_id: childId } }),
    ].join('\n') + '\n');
    await writeFile(childFile, [
      row('session_meta', { id: childId, cwd: root, parent_thread_id: parentId, source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: agentPath } } } }),
      row('turn_context', { turn_id: turnId, model: 'gpt-6-luna', effort: 'medium' }),
      row('event_msg', { type: 'task_started', turn_id: turnId }),
    ].join('\n') + '\n');

    const target = { root, parentSessionId: parentId, stage };
    const attestationPath = join(root, '.io/runtime/executions/exec-123/native-attestation.jsonl');
    await mkdir(join(root, '.io/runtime/executions/exec-123'), { recursive: true });
    const missing = { schema_version: 1, execution_id: stage.execution_id, stage_id: stage.stage_id, parent_session_id: parentId, native_agent_id: agentPath, thread_id: childId, status: 'unavailable', reason: 'completed_turn_metadata_missing' };
    const appendAttestation = (entry) => appendFile(attestationPath, `${JSON.stringify(entry)}\n`);
    await appendAttestation(missing);
    const refresh = refreshNativeCodexAttestation(target);
    await wait(425);
    await appendFile(childFile, row('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'submitted' }) + '\n');
    const attestation = await refresh;
    assert.equal(attestation.status, 'captured');
    assert.equal(attestation.source, 'codex-finish-transcript-refresh');
    assert.deepEqual(attestation.turns, [{ turn_id: turnId, status: 'completed', model: 'gpt-6-luna', reasoning_effort: 'medium' }]);

    const wrongBinding = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: 'unrelated-agent-id', requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'medium' } });
    assert.equal(wrongBinding.status, 'unavailable');
    assert.equal(wrongBinding.reason, 'parent_child_binding_not_found');
    const verifiedBinding = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: agentPath, requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'medium' } });
    assert.equal(verifiedBinding.status, 'verified');
    assert.equal(verifiedBinding.thread_id, childId);

    await appendAttestation({ ...attestation, stage_id: 'frontend-design' });
    await appendAttestation(missing);
    const readBack = await readNativeCodexAttestation(target);
    assert.equal(readBack.status, 'captured');
    assert.equal(readBack.stage_id, 'frontend-design');

    await unlink(parentFile);
    assert.deepEqual(await refreshNativeCodexAttestation(target), readBack);
    await appendAttestation({ ...missing, thread_id: '44444444-4444-4444-8444-444444444444' });
    assert.deepEqual(await refreshNativeCodexAttestation(target), { status: 'invalid', reason: 'attestation_binding_mismatch' });

    await unlink(attestationPath);
    await writeFile(parentFile, row('session_meta', { id: parentId, cwd: codexHome }) + '\n');
    assert.deepEqual(await refreshNativeCodexAttestation(target), { status: 'invalid', reason: 'parent_transcript_identity_mismatch' });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
