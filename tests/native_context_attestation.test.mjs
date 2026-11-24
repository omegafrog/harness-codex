import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { readNativeCodexAttestation, readNativeCodexSubmission, refreshNativeCodexAttestation, verifyNativeCodexWorkerBinding } from '../.harness/src/workflow/native-context.mjs';
import { appendRollout, childRollout, parentRollout, rolloutPath, writeRollout } from './support/codex-subagent-rollout.mjs';

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

// A real worker's SubagentStop hook fires before Codex appends task_complete, so the hook-time record never holds the
// completed turn (observed: hook 10:59:43.871Z, task_complete 10:59:43.890Z). The refresh that finish runs captures it.
test('the attestation recorded at SubagentStop lacks the completed turn that the transcript refresh later captures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-attestation-real-'));
  const codexHome = join(root, 'codex-home');
  const sessions = join(codexHome, 'sessions');
  const previousHome = process.env.CODEX_HOME;
  const stage = { stage_id: 'tactical-data', skill: 'tactical-data', execution_id: 'tactical-data-1', native_agent_id: '/root/tactical_data_jsonb', started_at: '2026-11-22T00:00:00.000Z' };
  try {
    process.env.CODEX_HOME = codexHome;
    await mkdir(join(root, '.io/runtime/executions', stage.execution_id), { recursive: true });
    const child = childRollout({ parentId, childId, cwd: root, agentPath: stage.native_agent_id, agentRole: 'tactical_designer' });
    const childFile = rolloutPath(sessions, childId);
    await writeRollout(rolloutPath(sessions, parentId), parentRollout({ parentId, cwd: root, childId, agentPath: stage.native_agent_id, startedAt: '2026-11-22T00:00:01.000Z' }));
    await writeRollout(childFile, [...child.stoppedRows, ...child.finalRows('{"status":"completed"}')]);
    const target = { root, parentSessionId: parentId, stage };
    // The hook ran: it recorded that no completed turn exists yet.
    const attestationPath = join(root, '.io/runtime/executions', stage.execution_id, 'native-attestation.jsonl');
    await writeFile(attestationPath, `${JSON.stringify({ schema_version: 1, source: 'codex-subagent-stop-hook', execution_id: stage.execution_id, stage_id: stage.stage_id, parent_session_id: parentId, native_agent_id: stage.native_agent_id, thread_id: childId, status: 'unavailable', turns: [], reason: 'completed_turn_metadata_missing' })}\n`);
    assert.equal((await readNativeCodexAttestation(target)).reason, 'completed_turn_metadata_missing');
    // Codex then appends task_complete with the final message.
    await appendRollout(childFile, [child.completeRow('{"status":"completed"}')]);
    const refreshed = await refreshNativeCodexAttestation(target);
    assert.equal(refreshed.status, 'captured');
    assert.equal(refreshed.source, 'codex-finish-transcript-refresh');
    assert.deepEqual(refreshed.turns, [{ turn_id: 'turn-child-1', status: 'completed', model: 'gpt-6-luna', reasoning_effort: 'medium' }]);
    assert.equal((await readNativeCodexAttestation(target)).status, 'captured');
    // A model that differs from the request is still reported as a mismatch, never as verified.
    const verified = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: stage.native_agent_id, requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'medium' } });
    assert.equal(verified.status, 'verified');
    const mismatch = await verifyNativeCodexWorkerBinding({ root, parentSessionId: parentId, stage, nativeAgentId: stage.native_agent_id, requestedBinding: { model: 'gpt-6-luna', reasoning_effort: 'high' } });
    assert.equal(mismatch.status, 'mismatch');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('the bound worker\'s final output is read from its own transcript only when it is one completed JSON object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-submission-'));
  const sessions = join(root, 'codex-home', 'sessions');
  const previousHome = process.env.CODEX_HOME;
  const stage = { stage_id: 'tactical-data', skill: 'tactical-data', execution_id: 'tactical-data-1', native_agent_id: '/root/tactical_data_jsonb', started_at: '2026-11-22T00:00:00.000Z' };
  const target = { root, parentSessionId: parentId, stage };
  const result = '{"schema_version":1,"skill":"tactical-data","status":"completed","code":"OK","result":{"summary":"완료"}}';
  try {
    process.env.CODEX_HOME = join(root, 'codex-home');
    await mkdir(root, { recursive: true });
    await writeRollout(rolloutPath(sessions, parentId), parentRollout({ parentId, cwd: root, childId, agentPath: stage.native_agent_id, startedAt: '2026-11-22T00:00:01.000Z' }));
    const child = childRollout({ parentId, childId, cwd: root, agentPath: stage.native_agent_id, agentRole: 'tactical_designer' });
    const childFile = rolloutPath(sessions, childId);
    const write = (rows) => writeRollout(childFile, [...child.stoppedRows, ...rows]);

    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'unavailable', reason: 'native_worker_outcome_unavailable', thread_id: childId }, 'no child transcript yet');
    await write([]);
    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'running', thread_id: childId }, 'the turn has started and not completed');
    await write([...child.finalRows(result)]);
    assert.equal((await readNativeCodexSubmission(target)).status, 'running', 'the final message is written before task_complete');
    await write([...child.finalRows(result), child.completeRow(result)]);
    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'completed', thread_id: childId, output: result });
    await write([child.completeRow(`\`\`\`json\n${result}\n\`\`\``)]);
    assert.equal((await readNativeCodexSubmission(target)).output, result, 'one code fence around the JSON object is removed');
    await write([child.completeRow(null)]);
    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'completed_without_json', thread_id: childId, reason: 'final_message_empty' });
    await write([child.completeRow('Done. The result file is attached.')]);
    assert.equal((await readNativeCodexSubmission(target)).reason, 'final_message_not_json_object');
    await write([child.completeRow('[1,2]')]);
    assert.equal((await readNativeCodexSubmission(target)).status, 'completed_without_json', 'a JSON array is not a stage result');
    await write([child.failedRow('context window exceeded')]);
    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'failed', thread_id: childId, error: 'context window exceeded' });
    await write([child.abortedRow()]);
    assert.deepEqual(await readNativeCodexSubmission(target), { status: 'interrupted', thread_id: childId });
    // A different agent path in the child's own metadata is not the bound worker.
    await writeRollout(childFile, [...childRollout({ parentId, childId, cwd: root, agentPath: '/root/another_agent' }).stoppedRows, child.completeRow(result)]);
    assert.equal((await readNativeCodexSubmission(target)).status, 'unavailable');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
