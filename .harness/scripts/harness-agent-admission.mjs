#!/usr/bin/env node
import { updateReviewAttempt, inspectActiveReviewAttempt, assertActiveReviewAdmission } from '../src/workflow/review-attempts.mjs';
import { snapshotSpecReview } from '../src/workflow/spec-review.mjs';
import { readPlanReviewerAdmission, snapshotPlanSet } from '../src/workflow/plan-review.mjs';
import { snapshotContractReview } from '../src/workflow/contract-review.mjs';
import { FRESH_AGENT_TYPES } from './harness-fresh-agent.mjs';

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
  const isContractReviewer = type === 'contract_reviewer';
  const isReviewer = isSpecReviewer || isPlanReviewer || isContractReviewer;
  const { nativeHookContext } = await import('../src/workflow/native-context.mjs');
  const native = process.env.HARNESS_REVIEW_EXECUTION_ID ? null : await nativeHookContext(typeof event.cwd === 'string' ? event.cwd : process.cwd(), [event.agent_id, event.parent_agent_id, event.session_id].filter(Boolean), { mainSession: !event.agent_id });
  if ((FRESH_AGENT_TYPES.includes(type) && (tool.resume || tool.fork || tool.fork_context)) || (native && (!type || type === 'fork'))) {
    deny('This Harness assignment requires a new Agent with an explicit profile and only the assigned input references. Continue a bound execution by messaging its existing agent.');
    process.exit(0);
  }
  if (process.env.HARNESS_NATIVE_ADMISSION && (process.env.HARNESS_SKILL_EXECUTION_ID || !native)) process.exit(0);
  const root = process.env.HARNESS_WORKSPACE_ROOT || native?.root;
  const executionId = process.env.HARNESS_REVIEW_EXECUTION_ID || native?.executionId;
  const ticketId = process.env.HARNESS_REVIEW_TICKET_ID || native?.planSetId;
  if (!root || root !== process.cwd() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId || '')) {
    if (!isReviewer) process.exit(0);
    throw new Error('Canonical review execution context is unavailable');
  }
  const specScope = `spec-${ticketId}-architecture`, planScope = `plan-${ticketId}`, contractScope = `contracts-${ticketId}`;
  const active = [];
  for (const scope of [specScope, planScope, contractScope]) {
    try { active.push({ scope, attempt: await inspectActiveReviewAttempt({ root, scope }) }); }
    catch (error) { if (error.message !== 'No active review attempt') throw error; }
  }
  if (!active.length && !isReviewer) process.exit(0);
  if (active.length !== 1 || !isReviewer || active[0].scope !== (isSpecReviewer ? specScope : isPlanReviewer ? planScope : contractScope)) throw new Error('An independent review admission is active; dispatch only its required reviewer profile');
  const { scope, attempt } = active[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '') || typeof tool.prompt !== 'string' || tool.resume || tool.run_in_background) throw new Error('Architecture reviewers must start fresh and finish before the caller continues');
  if (attempt.native_review) throw new Error('The active Architecture review admission is already claimed');
  await assertActiveReviewAdmission({ root, scope, attemptId: attempt.attempt_id, inputs: attempt.inputs });
  const currentInputs = isSpecReviewer ? await snapshotSpecReview({ root, ticketId }) : isPlanReviewer ? (await snapshotPlanSet({ root, planSetId: ticketId })).inputs : (await snapshotContractReview({ root })).inputs;
  if (JSON.stringify(currentInputs) !== JSON.stringify(attempt.inputs)) throw new Error('Architecture review admission is stale');
  let reviewerInputRef = null;
  if (isPlanReviewer) {
    reviewerInputRef = attempt.admission_ref;
    await readPlanReviewerAdmission({ root, planSetId: ticketId, attempt, executionId });
  }
  const reviewerId = `claude-${executionId}-${attempt.attempt_id}`;
  const nativeAgentId = `pending-${event.tool_use_id || attempt.attempt_id}`;
  await updateReviewAttempt({ root, scope, action: 'claim', attemptId: attempt.attempt_id, reviewerId, nativeAgentId, parentSessionId: event.session_id, executionId });
  const target = isSpecReviewer ? `ticket_id=${ticketId}; axis=architecture` : isContractReviewer ? `plan_set_id=${ticketId}; contract_revision=${attempt.inputs.revision}` : `plan_set_id=${ticketId}`;
  const prompt = `${tool.prompt}\n\nHarness review admission (runtime-bound): ${target}; attempt_id=${attempt.attempt_id}; reviewer_id=${reviewerId}${reviewerInputRef ? `; reviewer_input_ref=${reviewerInputRef}` : ''}. This reviewer identity is bound by the host. For plan review, treat the listed files and captured contents in reviewer_input_ref as the complete current admission; do not search .io or use archived restart documents as current input. Return only a JSON object with exactly the keys verdict and findings; do not include identity or prose. Do not delegate or spawn another reviewer.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Active independent review admission claimed', updatedInput: { ...tool, prompt } } })}\n`);
} catch (error) {
  deny(`Independent reviewer dispatch denied: ${error.message}`);
}
