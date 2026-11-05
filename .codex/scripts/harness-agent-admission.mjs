#!/usr/bin/env node
import { updateReviewAttempt, inspectActiveReviewAttempt, assertActiveReviewAdmission } from '../../.harness/src/workflow/review-attempts.mjs';
import { snapshotSpecReview } from '../../.harness/src/workflow/spec-review.mjs';
import { snapshotPlanSet } from '../../.harness/src/workflow/plan-review.mjs';

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
  const type = tool.subagent_type;
  const isSpecReviewer = type === 'spec_adversarial_reviewer';
  const isPlanReviewer = type === 'plan_reviewer';
  const isReviewer = isSpecReviewer || isPlanReviewer;
  const root = process.env.HARNESS_WORKSPACE_ROOT;
  const executionId = process.env.HARNESS_REVIEW_EXECUTION_ID;
  const ticketId = process.env.HARNESS_REVIEW_TICKET_ID;
  if (!root || root !== process.cwd() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId || '')) {
    if (!isReviewer) process.exit(0);
    throw new Error('Canonical review execution context is unavailable');
  }
  const specScope = `spec-${ticketId}-architecture`, planScope = `plan-${ticketId}`;
  const active = [];
  for (const scope of [specScope, planScope]) {
    try { active.push({ scope, attempt: await inspectActiveReviewAttempt({ root, scope }) }); }
    catch (error) { if (error.message !== 'No active review attempt') throw error; }
  }
  if (!active.length && !isReviewer) process.exit(0);
  if (active.length !== 1 || !isReviewer || active[0].scope !== (isSpecReviewer ? specScope : planScope)) throw new Error('An independent review admission is active; dispatch only its required reviewer profile');
  const { scope, attempt } = active[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '') || typeof tool.prompt !== 'string' || tool.resume || tool.run_in_background) throw new Error('Architecture reviewers must start fresh and finish before the caller continues');
  if (attempt.native_review) throw new Error('The active Architecture review admission is already claimed');
  await assertActiveReviewAdmission({ root, scope, attemptId: attempt.attempt_id, inputs: attempt.inputs });
  const currentInputs = isSpecReviewer ? await snapshotSpecReview({ root, ticketId }) : (await snapshotPlanSet({ root, planSetId: ticketId })).inputs;
  if (JSON.stringify(currentInputs) !== JSON.stringify(attempt.inputs)) throw new Error('Architecture review admission is stale');
  const reviewerId = `claude-${executionId}-${attempt.attempt_id}`;
  const nativeAgentId = `pending-${event.tool_use_id || attempt.attempt_id}`;
  await updateReviewAttempt({ root, scope, action: 'claim', attemptId: attempt.attempt_id, reviewerId, nativeAgentId, parentSessionId: event.session_id, executionId });
  const target = isSpecReviewer ? `ticket_id=${ticketId}; axis=architecture` : `plan_set_id=${ticketId}`;
  const prompt = `${tool.prompt}\n\nHarness review admission (runtime-bound): ${target}; attempt_id=${attempt.attempt_id}; reviewer_id=${reviewerId}. This reviewer identity is bound by the host. Return only a JSON object with exactly the keys verdict and findings; do not include identity or prose. Do not delegate or spawn another reviewer.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Active independent review admission claimed', updatedInput: { ...tool, prompt } } })}\n`);
} catch (error) {
  deny(`Independent reviewer dispatch denied: ${error.message}`);
}
