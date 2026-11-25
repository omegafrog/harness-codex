#!/usr/bin/env node
import { updateReviewAttempt, inspectActiveReviewAttempt, assertActiveReviewAdmission } from '../../../.harness/src/workflow/review-attempts.mjs';
import { snapshotSpecReview } from '../../../.harness/src/workflow/spec-review.mjs';
import { captureReviewSnapshotAtLaunch, snapshotPlanSet } from '../../../.harness/src/workflow/plan-review.mjs';
import { contractReviewBrief, snapshotContractReview } from '../../../.harness/src/workflow/contract-review.mjs';
import { assertReviewDraftComposed, readWriterAssignment, readWriterBatch } from '../../../.harness/src/workflow/stage-documents.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sessionOutputPath } from '../../../.harness/src/workflow/session-output.mjs';
import { normalizeReviewContent } from '../../../.harness/src/workflow/review-delta.mjs';
import { FRESH_AGENT_TYPES } from '../../../.harness/scripts/harness-fresh-agent.mjs';
await import('../../../.harness/src/observability/hook-timing.mjs').then((module) => module.startHookTiming('agent-admission'), () => null);

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
  // A stage dispatch is one Agent call whose prompt starts with `harness-stage:`: launch it here and rewrite the call into its worker.
  if (typeof tool.prompt === 'string' && /^\s*harness-stage:/.test(tool.prompt)) {
    const { admitStageDispatch } = await import('../../../.harness/src/workflow/claude-stage-dispatch.mjs');
    const stage = await admitStageDispatch(event);
    if (stage?.deny) deny(stage.deny);
    else process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Harness stage launched', updatedInput: stage.updatedInput } })}\n`);
    process.exit(0);
  }
  const type = tool.subagent_type;
  const isSpecReviewer = type === 'spec_adversarial_reviewer';
  const isPlanReviewer = type === 'plan_reviewer';
  const isContractReviewer = type === 'contract_reviewer';
  const isReviewer = isSpecReviewer || isPlanReviewer || isContractReviewer;
  const { nativeHookContext } = await import('../../../.harness/src/workflow/native-context.mjs');
  const native = process.env.HARNESS_REVIEW_EXECUTION_ID ? null : await nativeHookContext(typeof event.cwd === 'string' ? event.cwd : process.cwd(), [event.agent_id, event.parent_agent_id, event.session_id].filter(Boolean), { mainSession: !event.agent_id });
  if ((FRESH_AGENT_TYPES.includes(type) && (tool.resume || tool.fork || tool.fork_context)) || (native && (!type || type === 'fork'))) {
    deny('This Harness assignment requires a new Agent with an explicit profile and only the assigned input references. Continue a bound execution by messaging its existing agent.');
    process.exit(0);
  }
  // A headless `claude -p` exits when the orchestrator's turn ends, which kills a background worker mid-stage.
  if (FRESH_AGENT_TYPES.includes(type) && tool.run_in_background) {
    deny('Run Harness stage workers in the foreground: pass run_in_background: false and do not end your turn until the Agent returns. A background worker dies when the headless orchestrator turn ends and leaves the stage running.');
    process.exit(0);
  }
  // A stage worker's code research, persona and gap review run on their configured binding, not on the worker's inherited or passed model.
  const BOUND_SKILLS = { code_researcher: 'code-research', stakeholder_persona: 'stakeholder-persona', requirements_gap_reviewer: 'requirements-gap-review' };
  if (Object.hasOwn(BOUND_SKILLS, type) && native && event.agent_id) {
    const { resolveSkillBinding } = await import('../../../.harness/src/workflow/stage-runtime.mjs');
    const { model, reasoning_effort: effort } = await resolveSkillBinding({ root: native.root, skill: BOUND_SKILLS[type], executionProvider: 'claude-code' });
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Harness bound agent model', updatedInput: { ...tool, model, ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? { effort } : {}), run_in_background: false } } })}\n`);
    process.exit(0);
  }
  if (process.env.HARNESS_NATIVE_ADMISSION && (process.env.HARNESS_STAGE_EXECUTION_ID || !native)) process.exit(0);
  const root = process.env.HARNESS_WORKSPACE_ROOT || native?.root;
  const executionId = process.env.HARNESS_REVIEW_EXECUTION_ID || native?.executionId;
  const ticketId = process.env.HARNESS_REVIEW_TICKET_ID || native?.planSetId;
  if (type === 'stage_document_writer') {
    if (!root || root !== process.cwd() || !executionId || event.agent_id) throw new Error('Only the main Claude orchestrator may dispatch its prepared stage document writer');
    const batch = await readWriterBatch(root, executionId);
    if (batch.binding.provider !== 'claude-code' || !batch.binding.model || tool.model !== batch.binding.model) throw new Error(`Pass the configured stage document writer model explicitly to Agent: ${batch.binding.model || 'unavailable'}`);
    if (await readWriterAssignment(root, executionId)) throw new Error('The stage document writer is already assigned');
  }
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
  const { scope } = active[0];
  let { attempt } = active[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '') || typeof tool.prompt !== 'string' || tool.resume || tool.run_in_background) throw new Error('Architecture reviewers must start fresh and finish before the caller continues');
  if (attempt.native_review) throw new Error('The active Architecture review admission is already claimed');
  if (isPlanReviewer && attempt.admission_execution_id !== executionId) throw new Error('Plan review admission does not belong to the running execution');
  // A plan review's snapshot is taken at this launch: edits made after `begin` are re-captured into the admission.
  if (isPlanReviewer && (await captureReviewSnapshotAtLaunch({ root, planSetId: ticketId })).refreshed) attempt = await inspectActiveReviewAttempt({ root, scope });
  await assertActiveReviewAdmission({ root, scope, attemptId: attempt.attempt_id, inputs: attempt.inputs });
  if (isContractReviewer) await assertReviewDraftComposed(root, executionId, 'sync-contracts');
  const contract = isContractReviewer ? await snapshotContractReview({ root, executionId }) : null;
  const currentInputs = isSpecReviewer ? await snapshotSpecReview({ root, ticketId }) : isPlanReviewer ? (await snapshotPlanSet({ root, planSetId: ticketId, executionId })).inputs : contract.inputs;
  if (JSON.stringify(currentInputs) !== JSON.stringify(attempt.inputs)) throw new Error('Architecture review admission is stale');
  let reviewerInputRef = null;
  if (isPlanReviewer) {
    reviewerInputRef = attempt.admission_ref;
    if (!reviewerInputRef || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(attempt.admission_execution_id || '')) throw new Error('The active plan review has no runner-owned admission reference');
    const admitted = JSON.parse(await readFile(sessionOutputPath(root, reviewerInputRef), 'utf8'));
    if (admitted.schema_version !== 1 || admitted.execution_id !== attempt.admission_execution_id || admitted.attempt_id !== attempt.attempt_id || admitted.plan_set_id !== ticketId || JSON.stringify(admitted.inputs) !== JSON.stringify(attempt.inputs) || !Array.isArray(admitted.files) || admitted.files.length !== Object.keys(attempt.inputs).length || admitted.files.some((file) => {
      if (attempt.inputs[file.path] !== file.sha256 || typeof file.content !== 'string' || !['raw-v1', 'frontmatter-status-excluded-v1'].includes(file.normalization)) return true;
      const content = file.normalization === 'frontmatter-status-excluded-v1' ? normalizeReviewContent(file.path, Buffer.from(file.content)) : file.content;
      return createHash('sha256').update(content).digest('hex') !== file.sha256;
    })) throw new Error('Runner-owned plan reviewer inputs do not match the active admission');
  }
  const reviewerId = `claude-${executionId}-${attempt.attempt_id}`;
  const nativeAgentId = `pending-${event.tool_use_id || attempt.attempt_id}`;
  const contractInputs = contract ? await contractReviewBrief({ root, planSetId: ticketId, snapshot: contract, executionId }) : null;
  await updateReviewAttempt({ root, scope, action: 'claim', attemptId: attempt.attempt_id, reviewerId, nativeAgentId, parentSessionId: event.session_id, executionId });
  const target = isSpecReviewer ? `ticket_id=${ticketId}; axis=architecture` : isContractReviewer ? `plan_set_id=${ticketId}; contract_revision=${attempt.inputs.revision}` : `plan_set_id=${ticketId}`;
  const prompt = `${tool.prompt}\n\nHarness review admission (runtime-bound): ${target}; attempt_id=${attempt.attempt_id}; reviewer_id=${reviewerId}${reviewerInputRef ? `; reviewer_input_ref=${reviewerInputRef}` : ''}. This reviewer identity is bound by the host.${reviewerInputRef ? ' Read the listed files and captured contents in reviewer_input_ref as the complete current admission.' : ''}${contractInputs ? ` Read the exact references in this contract brief. Use contract_file_sources when it specifies a different location for a contract file. ${JSON.stringify(contractInputs)}` : ''} Return only a JSON object with exactly the keys verdict and findings; do not include identity or prose. Do not delegate or spawn another reviewer.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Active independent review admission claimed', updatedInput: { ...tool, prompt } } })}\n`);
} catch (error) {
  deny(`Independent reviewer dispatch denied: ${error.message}`);
}
