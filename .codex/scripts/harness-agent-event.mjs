#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWorkspaceTarget } from '../../.harness/src/eval/case-workspace.mjs';
import { inspectActiveReviewAttempt, updateReviewAttempt } from '../../.harness/src/workflow/review-attempts.mjs';

async function forkedTranscript(path) {
  if (typeof path !== 'string' || !path) return false;
  const first = (await readFile(path, 'utf8').catch(() => '')).split('\n', 1)[0];
  try { return Boolean(JSON.parse(first)?.payload?.forked_from_id); } catch { return false; }
}

// Claude Code can reach this script through both the project settings and a stage's --settings, and runs them
// concurrently. The first caller for an (event, agent) claims it with an exclusive marker; the others stop quietly.
let claimedMarker = null;
async function claimEvent(directory, event) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, `.claimed-${event.hook_event_name}-${event.agent_id}`.replace(/[^A-Za-z0-9._-]/g, '_'));
  try { await writeFile(marker, '', { flag: 'wx', mode: 0o600 }); claimedMarker = marker; return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (text.length > 1024 * 1024) throw new Error('Subagent event is too large');
  const event = JSON.parse(text);
  if (!['SubagentStart', 'SubagentStop'].includes(event.hook_event_name) || typeof event.session_id !== 'string' || typeof event.agent_id !== 'string' || !event.agent_id || typeof event.agent_type !== 'string') throw new Error('Invalid Claude subagent event');
  const session = process.env.HARNESS_SESSION_DIR, executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
  if (!executionId) {
    // The main orchestrator spawns the code reviewers itself. Record only those, in the worktree's own session,
    // so `harness-code-review.mjs assemble` takes reviewer identity and answers from the hook, not from the caller.
    if (!['standards_reviewer', 'spec_reviewer'].includes(event.agent_type)) process.exit(0);
    const recordFile = join(typeof event.cwd === 'string' ? event.cwd : process.cwd(), '.io/worktree.json');
    let worktree;
    try { worktree = JSON.parse(await readFile(recordFile, 'utf8')); } catch { process.exit(0); }
    if (!worktree?.session_directory || worktree.state !== 'active') process.exit(0);
    if (!await claimEvent(join(worktree.session_directory, 'runtime/orchestrator'), event)) process.exit(0);
    const orchestratorLog = 'runtime/orchestrator/subagents.jsonl';
    await assertWorkspaceTarget(worktree.session_directory, orchestratorLog);
    const target = join(worktree.session_directory, orchestratorLog);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await appendFile(target, `${JSON.stringify({
      event: event.hook_event_name, session_id: event.session_id, agent_id: event.agent_id, agent_type: event.agent_type,
      // Codex may not have flushed the transcript when SubagentStart fires; check again when the reviewer stops.
      ...(await forkedTranscript(event.agent_transcript_path) ? { forked: true } : {}),
      ...(event.hook_event_name === 'SubagentStop' && typeof event.last_assistant_message === 'string' ? { result: event.last_assistant_message } : {}),
      recorded_at: new Date().toISOString(),
    })}\n`, { flag: 'a', mode: 0o600 });
    process.exit(0);
  }
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) throw new Error('Harness execution session is unavailable');
  if (!await claimEvent(join(session, 'runtime/executions', executionId), event)) process.exit(0);
  const relative = `runtime/executions/${executionId}/subagents.jsonl`;
  await assertWorkspaceTarget(session, relative);
  const path = join(session, relative);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const prior = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1)) throw new Error('Unsafe subagent event log');
  const record = {
    event: event.hook_event_name,
    session_id: event.session_id,
    agent_id: event.agent_id,
    agent_type: event.agent_type,
    ...(event.agent_transcript_path ? { transcript_path: event.agent_transcript_path } : {}),
    ...(event.hook_event_name === 'SubagentStop' && typeof event.last_assistant_message === 'string' ? { result: event.last_assistant_message } : {}),
    recorded_at: new Date().toISOString(),
  };
  // Each reviewer profile that a stage runs inside its own review loop has one review-history scope.
  const reviewScopes = { spec_adversarial_reviewer: (id) => `spec-${id}-architecture`, plan_reviewer: (id) => `plan-${id}`, contract_reviewer: (id) => `contracts-${id}` };
  if (Object.hasOwn(reviewScopes, event.agent_type)) {
    const ticketId = process.env.HARNESS_REVIEW_TICKET_ID;
    const executionId = process.env.HARNESS_REVIEW_EXECUTION_ID;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) throw new Error('Canonical review ticket or execution is unavailable');
    const scope = reviewScopes[event.agent_type](ticketId);
    record.review_scope = scope;
    let attempt = null;
    try { attempt = await inspectActiveReviewAttempt({ root: process.cwd(), scope }); }
    catch { attempt = null; }
    // A reviewer started outside an admitted attempt, or forked from the author's conversation, is
    // recorded as such and never bound; completion gates reject stages that used one.
    const forked = await forkedTranscript(event.agent_transcript_path);
    if (!attempt || forked) {
      record.admitted = false;
      if (forked) record.forked = true;
    } else if (event.hook_event_name === 'SubagentStart') {
      // Claude Code claims the attempt before dispatch (PreToolUse admission); Codex has no such hook, so claim here.
      if (!attempt.native_review) await updateReviewAttempt({ root: process.cwd(), scope, action: 'claim', attemptId: attempt.attempt_id, reviewerId: event.agent_id, nativeAgentId: event.agent_id, parentSessionId: event.session_id, executionId });
      else if (attempt.native_review.parent_session_id !== event.session_id || attempt.native_review.execution_id !== executionId) throw new Error('Native reviewer session or execution does not match the admitted caller');
      await updateReviewAttempt({ root: process.cwd(), scope, action: 'bind-native', attemptId: attempt.attempt_id, nativeAgentId: event.agent_id, parentSessionId: event.session_id });
      record.review_attempt_id = attempt.attempt_id;
    } else if (attempt.native_review?.agent_id === event.agent_id) {
      const nativeReview = JSON.parse(event.last_assistant_message || 'null');
      if (!nativeReview || Object.keys(nativeReview).sort().join(',') !== 'findings,verdict' || !['pass', 'revise', 'reject', 'blocked'].includes(nativeReview.verdict) || !Array.isArray(nativeReview.findings)) throw new Error('Native reviewer final message must be exactly one JSON object with verdict and findings');
      await updateReviewAttempt({ root: process.cwd(), scope, action: 'stop-native', attemptId: attempt.attempt_id, nativeAgentId: event.agent_id, parentSessionId: event.session_id, nativeResult: event.last_assistant_message, nativeReview });
      record.review_attempt_id = attempt.attempt_id;
    } else if (attempt.native_review) throw new Error('Native reviewer event does not match the claimed reviewer');
    else record.admitted = false;
  }
  await appendFile(path, `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 });
} catch (error) {
  // A failed attempt must not block a later valid delivery of the same event.
  if (claimedMarker) await rm(claimedMarker, { force: true });
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
