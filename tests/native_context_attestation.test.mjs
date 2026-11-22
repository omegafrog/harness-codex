import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      row('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'submitted' }),
    ].join('\n') + '\n');

    const wrongBinding = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: 'unrelated-agent-id', requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'medium' } });
    assert.equal(wrongBinding.status, 'unavailable');
    assert.equal(wrongBinding.reason, 'parent_child_binding_not_found');
    const verifiedBinding = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: agentPath, requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'medium' } });
    assert.equal(verifiedBinding.status, 'verified');
    assert.equal(verifiedBinding.thread_id, childId);

    const attestation = await refreshNativeCodexAttestation({ root, parentSessionId: parentId, stage });
    assert.equal(attestation.status, 'captured');
    assert.equal(attestation.source, 'codex-finish-transcript-refresh');
    assert.deepEqual(attestation.turns, [{ turn_id: turnId, status: 'completed', model: 'gpt-6-luna', reasoning_effort: 'medium' }]);
    const attestationPath = join(root, '.io/runtime/executions/exec-123/native-attestation.jsonl');
    await appendFile(attestationPath, `${JSON.stringify({ ...attestation, stage_id: 'frontend-design' })}\n`);
    const readBack = await readNativeCodexAttestation({ root, parentSessionId: parentId, stage });
    assert.equal(readBack.status, 'captured');
    assert.equal(readBack.stage_id, 'frontend-design');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
