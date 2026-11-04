import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSkillSessionJson, validateSkillReturn } from './skill-execution.mjs';

// Keep the parent conversation while the runner dispatches each fresh writer.
export async function runSpecWriterLoop({ root, session, input, output, prompt, resume, runParent, dispatchWriter, onWriterStart, onEvent = () => {}, readRequest = readSkillSessionJson, validateRequest = validateSkillReturn }) {
  const journalPath = (id) => join(session, 'runtime/executions', id, 'writer-pending.json');
  const saveJournal = async (journal) => {
    const path = journalPath(input.execution_id), temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(journal) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  };
  let pending, handoff = null;
  if (input.context?.interrupted_execution_id) {
    try { pending = JSON.parse(await readFile(journalPath(input.context.interrupted_execution_id), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending && pending.phase !== 'delivered') {
      if (!resume || pending.parent_session_id !== resume || !['requested', 'writer_completed'].includes(pending.phase)) throw new Error('Interrupted writer handoff requires inspection');
      const restored = await readRequest({ root, session_directory: session, path: pending.request_path });
      const digest = createHash('sha256').update(JSON.stringify(restored)).digest('hex');
      if (digest !== pending.request_sha256 || restored.axis !== pending.axis || restored.plan_set_id !== input.context.plan_set_id || pending.provider !== input.context.provider) throw new Error('Interrupted writer request changed; inspection required');
      if (pending.phase === 'requested') {
        const written = await dispatchWriter({ root, worktreeRef: input.context.worktree_ref, executionId: input.context.interrupted_execution_id, requestPath: pending.request_path, expectedAxis: pending.axis, expectedProvider: input.context.provider, approvedOverwriteDigest: input.context.approved_spec_overwrites?.[pending.axis], onWriterStart });
        if (written.status !== 'completed' || !written.receipt_ref) throw new Error('Interrupted writer has no completed receipt');
        pending = { ...pending, phase: 'writer_completed', receipt_ref: written.receipt_ref };
      }
      resume = pending.parent_session_id;
      prompt = `The ${pending.axis} Spec writer completed. Read the writer receipt at ${join(session, pending.receipt_ref)} and continue the spec-me skill. Preserve its settled decisions and complete the required review and diagram gates.`;
      handoff = { ...pending, phase: 'writer_completed' };
      await saveJournal(handoff);
    }
  }
  for (let round = 0; round < 9; round++) {
    const result = await runParent({ output, prompt, resume });
    if (handoff && result.code === 0) { await saveJournal({ ...handoff, phase: 'delivered' }); handoff = null; }
    if (result.code !== 0 || input.skill !== 'spec-me') return result;
    const outputInfo = await lstat(output);
    if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.nlink > 1) throw new Error('Parent writer request output must be a regular unshared file');
    const envelope = JSON.parse(await readFile(output, 'utf8'));
    const request = envelope.result?.review_request;
    if (envelope.status !== 'action_required' || envelope.code !== 'REVIEW_REQUIRED' || request?.agent_profile !== 'spec_document_writer') return result;
    const axis = { 'product-spec': 'product', 'architecture-spec': 'architecture' }[request.skill];
    if (!axis || !result.sessionId) throw new Error('Spec writer request needs a valid axis and parent session');
    const requestData = await readRequest({ root, session_directory: session, path: request.context_path });
    if (requestData.axis !== axis || requestData.plan_set_id !== input.context?.plan_set_id) throw new Error('Spec writer request does not match the worktree and axis');
    envelope.result_ref ||= `runtime/executions/${input.execution_id}/result.json`;
    await validateRequest({ root, input, envelope });
    const request_sha256 = createHash('sha256').update(JSON.stringify(requestData)).digest('hex');
    await saveJournal({ phase: 'requested', parent_session_id: result.sessionId, axis, request_path: request.context_path, request_sha256, provider: input.context.provider });
    const prefix = join(session, 'runtime/executions', input.execution_id);
    const storedResult = join(prefix, 'result.json');
    const info = await lstat(storedResult).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info) {
      const withoutHashes = (value) => ({ ...value, artifacts: (value.artifacts || []).map(({ sha256, ...artifact }) => artifact) });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !isDeepStrictEqual(withoutHashes(JSON.parse(await readFile(storedResult, 'utf8'))), withoutHashes(envelope.result))) throw new Error('Stored writer request differs from the returned request');
      await rename(storedResult, join(prefix, `writer-request-${round + 1}-result.json`));
    }
    await rename(output, join(prefix, `writer-request-${round + 1}.json`));
    onEvent({ event: 'spec_writer_requested', axis, request_path: request.context_path });
    const written = await dispatchWriter({ root, worktreeRef: input.context.worktree_ref, executionId: input.execution_id, requestPath: request.context_path, expectedAxis: axis, expectedProvider: input.context.provider, approvedOverwriteDigest: input.context.approved_spec_overwrites?.[axis], onWriterStart });
    if (written.status !== 'completed' || !written.receipt_ref) throw new Error('Spec writer did not complete with a receipt');
    await saveJournal({ phase: 'writer_completed', parent_session_id: result.sessionId, axis, request_path: request.context_path, request_sha256, provider: input.context.provider, receipt_ref: written.receipt_ref });
    onEvent({ event: 'spec_writer_completed', axis, receipt_ref: written.receipt_ref });
    resume = result.sessionId;
    prompt = `The ${axis} Spec writer completed. Read the writer receipt at ${join(session, written.receipt_ref)} and continue the spec-me skill. Preserve its settled decisions and complete the required review and diagram gates.`;
    handoff = { phase: 'writer_completed', parent_session_id: result.sessionId, axis, request_path: request.context_path, request_sha256, provider: input.context.provider, receipt_ref: written.receipt_ref };
  }
  throw new Error('Spec writer request limit exceeded');
}
