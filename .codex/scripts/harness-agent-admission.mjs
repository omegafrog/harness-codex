#!/usr/bin/env node
import { updateReviewAttempt, inspectActiveReviewAttempt, assertActiveReviewAdmission } from '../../.harness/src/workflow/review-attempts.mjs';
import { snapshotSpecReview } from '../../.harness/src/workflow/spec-review.mjs';

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
}

try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (text.length > 1024 * 1024) throw new Error('Agent tool input is too large');
  const event = JSON.parse(text);
  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Agent') throw new Error('Invalid Agent admission event');
  const tool = event.tool_input || {};
  const isReviewer = tool.subagent_type === 'spec_adversarial_reviewer';
  const root = process.env.HARNESS_WORKSPACE_ROOT;
  const executionId = process.env.HARNESS_REVIEW_EXECUTION_ID;
  const ticketId = process.env.HARNESS_REVIEW_TICKET_ID;
  if (!root || root !== process.cwd() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId || '')) {
    if (!isReviewer) process.exit(0);
    throw new Error('Canonical review execution context is unavailable');
  }
  const scope = `spec-${ticketId}-architecture`;
  let attempt;
  try { attempt = await inspectActiveReviewAttempt({ root, scope }); }
  catch (error) {
    if (!isReviewer && error.message === 'No active review attempt') process.exit(0);
    throw error;
  }
  if (!isReviewer) throw new Error('An Architecture review admission is active; dispatch its required reviewer profile before other agents');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '') || typeof tool.prompt !== 'string' || tool.resume || tool.run_in_background) throw new Error('Architecture reviewers must start fresh and finish before the caller continues');
  if (attempt.native_review) throw new Error('The active Architecture review admission is already claimed');
  await assertActiveReviewAdmission({ root, scope, attemptId: attempt.attempt_id, inputs: attempt.inputs });
  const currentInputs = await snapshotSpecReview({ root, ticketId });
  if (JSON.stringify(currentInputs) !== JSON.stringify(attempt.inputs)) throw new Error('Architecture review admission is stale');
  const reviewerId = `claude-${executionId}-${attempt.attempt_id}`;
  const nativeAgentId = `pending-${event.tool_use_id || attempt.attempt_id}`;
  await updateReviewAttempt({ root, scope, action: 'claim', attemptId: attempt.attempt_id, reviewerId, nativeAgentId, parentSessionId: event.session_id, executionId });
  const prompt = `${tool.prompt}\n\nHarness review admission (runtime-bound): ticket_id=${ticketId}; axis=architecture; attempt_id=${attempt.attempt_id}; reviewer_id=${reviewerId}. This reviewer identity is bound by the host. Return only a JSON object with exactly the keys verdict and findings; do not include identity or prose. Do not delegate or spawn another reviewer.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Active architecture review admission claimed', updatedInput: { ...tool, prompt } } })}\n`);
} catch (error) {
  deny(`Architecture reviewer dispatch denied: ${error.message}`);
}
