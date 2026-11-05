import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { snapshotSpecReview } from '../.harness/src/workflow/spec-review.mjs';
import { snapshotPlanSet, updatePlanReview } from '../.harness/src/workflow/plan-review.mjs';
import { updateReviewAttempt, inspectReviewHistory, assertNoUnrecordedNativeReview } from '../.harness/src/workflow/review-attempts.mjs';

const callAdmission = (root, ticketId, input) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-agent-admission.mjs')], {
  cwd: root,
  env: { ...process.env, HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_CONTROL_SESSION_DIR: join(root, '.io'), HARNESS_SKILL_EXECUTION_ID: 'review-stage', HARNESS_REVIEW_EXECUTION_ID: 'review-stage', HARNESS_REVIEW_TICKET_ID: ticketId, HARNESS_WORKSPACE_ROOT: root },
  input: JSON.stringify(input), encoding: 'utf8',
}));
const callEvent = (root, event) => {
  const result = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-agent-event.mjs')], {
    cwd: root,
    env: { ...process.env, HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_SKILL_EXECUTION_ID: 'review-stage', HARNESS_REVIEW_EXECUTION_ID: 'review-stage', HARNESS_REVIEW_TICKET_ID: 'ticket-one' },
    input: JSON.stringify(event), encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

test('installed Claude review admission guards native reviewer dispatch and keeps consumer-owned files visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-claude-review-consumer-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await mkdir(join(root, 'docs/specs/ticket-one'), { recursive: true });
    await writeFile(join(root, 'docs/specs/ticket-one/product-spec.md'), 'Status: approved\nProduct requirements.\n');
    await writeFile(join(root, 'docs/specs/ticket-one/architecture-spec.md'), 'Status: approved\nArchitecture.\n');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'Project-owned execution notes.\n');
    await mkdir(join(root, 'docs/contracts'), { recursive: true });
    await writeFile(join(root, 'docs/contracts/owned.md'), 'Project-owned contract.\n');

    const provider = await import(`file://${join(root, '.harness/src/workflow/providers/claude-code.mjs')}`);
    const command = provider.buildCommand({ root, sandbox: 'workspace-write', binding: { model: 'claude-sonnet', reasoning_effort: 'medium' }, schema: {}, resume: 'resume-id', role: null, skill: 'spec-me', workerBase: 'Compact worker base.' });
    const settings = JSON.parse(command[command.indexOf('--settings') + 1]);
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Agent');
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command.includes('harness-agent-admission.mjs'), true);
    assert.equal(command[command.indexOf('--system-prompt') + 1].startsWith('Compact worker base.'), true);
    assert.equal(command[command.indexOf('--system-prompt-snapshot') + 1], 'off');
    assert.ok(provider.allowedToolsForRole('spec-me', 'spec-me').includes('Agent'));
    assert.equal(provider.allowedToolsForRole('spec_adversarial_reviewer').includes('Agent'), false);
    assert.equal(provider.allowedToolsForRole('plan_reviewer').includes('Agent'), false);
    assert.equal(provider.allowedToolsForRole('plan_reviewer').includes('Write'), false);
    const installedReviewer = await readFile(join(root, '.claude/agents/spec_adversarial_reviewer.md'), 'utf8');
    assert.match(installedReviewer, /tools: Read, Grep, Glob, WebSearch, WebFetch/);
    assert.match(installedReviewer, /exactly one JSON object with only `verdict` and `findings` keys/);

    const input = { hook_event_name: 'PreToolUse', session_id: 'claude-session', tool_name: 'Agent', tool_use_id: 'dispatch-1', tool_input: { subagent_type: 'spec_adversarial_reviewer', prompt: 'Review the Specs.' } };
    assert.equal(callAdmission(root, 'ticket-missing', input).hookSpecificOutput.permissionDecision, 'deny');
    let admitted = await updateReviewAttempt({ root, scope: 'spec-ticket-one-architecture', action: 'begin', inputs: await snapshotSpecReview({ root, ticketId: 'ticket-one' }) });
    assert.equal(callAdmission(root, 'ticket-other', input).hookSpecificOutput.permissionDecision, 'deny');
    await writeFile(join(root, 'docs/specs/ticket-one/architecture-spec.md'), 'Status: approved\nChanged after admission.\n');
    assert.equal(callAdmission(root, 'ticket-one', input).hookSpecificOutput.permissionDecision, 'deny');
    await updateReviewAttempt({ root, scope: 'spec-ticket-one-architecture', action: 'abort', attemptId: admitted.attempt_id, reason: 'pre-dispatch preparation: stale Spec snapshot' });

    admitted = await updateReviewAttempt({ root, scope: 'spec-ticket-one-architecture', action: 'begin', inputs: await snapshotSpecReview({ root, ticketId: 'ticket-one' }) });
    const allowed = callAdmission(root, 'ticket-one', input);
    assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(allowed.hookSpecificOutput.updatedInput.prompt, new RegExp(`reviewer_id=claude-review-stage-${admitted.attempt_id}`));
    assert.equal(callAdmission(root, 'ticket-one', input).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(callAdmission(root, 'ticket-one', { ...input, tool_input: { ...input.tool_input, subagent_type: 'general-purpose' } }).hookSpecificOutput.permissionDecision, 'deny');
    assert.throws(() => callEvent(root, { hook_event_name: 'SubagentStart', session_id: 'other-session', agent_id: 'native-agent-1', agent_type: 'spec_adversarial_reviewer' }));
    assert.throws(() => callEvent(root, { hook_event_name: 'SubagentStop', session_id: 'claude-session', agent_id: 'native-agent-1', agent_type: 'spec_adversarial_reviewer', last_assistant_message: '{"verdict":"pass","findings":[]}' }));

    callEvent(root, { hook_event_name: 'SubagentStart', session_id: 'claude-session', agent_id: 'native-agent-1', agent_type: 'spec_adversarial_reviewer' });
    const nativeResult = JSON.stringify({ verdict: 'pass', findings: [] });
    callEvent(root, { hook_event_name: 'SubagentStop', session_id: 'claude-session', agent_id: 'native-agent-1', agent_type: 'spec_adversarial_reviewer', last_assistant_message: nativeResult });
    await assert.rejects(assertNoUnrecordedNativeReview({ root, scope: 'spec-ticket-one-architecture' }), /record/i);
    const history = await inspectReviewHistory({ root, scope: 'spec-ticket-one-architecture' });
    await updateReviewAttempt({ root, scope: 'spec-ticket-one-architecture', action: 'record', attemptId: admitted.attempt_id, inputs: admitted.inputs, review: { axis: 'architecture', ticket_id: 'ticket-one', reviewer_id: `claude-review-stage-${admitted.attempt_id}`, author_ids: ['spec-author'], fork_turns: 'none', verdict: 'pass', findings: [] } });
    assert.equal(history.recorded_state, 'active');
    await assertNoUnrecordedNativeReview({ root, scope: 'spec-ticket-one-architecture' });

    await mkdir(join(root, 'docs/plans/ticket-one'), { recursive: true });
    await writeFile(join(root, 'docs/plans/ticket-one/plans.md'), '# Plans\nProduct Spec: `docs/specs/ticket-one/product-spec.md`\nArchitecture Spec: `docs/specs/ticket-one/architecture-spec.md`\n');
    await writeFile(join(root, 'docs/plans/ticket-one/slice.md'), '---\nstatus: planned\n---\n# Slice\n');
    const planScope = 'plan-ticket-one';
    const runtimeEnv = { HARNESS_PROVIDER_ID: process.env.HARNESS_PROVIDER_ID, HARNESS_WORKSPACE_ROOT: process.env.HARNESS_WORKSPACE_ROOT, HARNESS_SKILL_EXECUTION_ID: process.env.HARNESS_SKILL_EXECUTION_ID };
    let planHistory;
    try {
    process.env.HARNESS_PROVIDER_ID = 'claude-code';
    process.env.HARNESS_WORKSPACE_ROOT = root;
    process.env.HARNESS_SKILL_EXECUTION_ID = 'review-stage';
    const unclaimedAttempt = await updatePlanReview({ root, planSetId: 'ticket-one', action: 'begin' });
    await assert.rejects(updatePlanReview({ root, planSetId: 'ticket-one', action: 'record', attemptId: unclaimedAttempt.attempt_id, review: { reviewer_id: 'invented-reviewer', author_ids: ['to-ticket-author'], fork_turns: 'none', verdict: 'pass', findings: [] } }), /stopped native reviewer bound to this admission/);
    await updatePlanReview({ root, planSetId: 'ticket-one', action: 'abort', attemptId: unclaimedAttempt.attempt_id, reason: 'pre-dispatch preparation: no native reviewer was dispatched' });
    const workspaceRoot = process.env.HARNESS_WORKSPACE_ROOT;
    delete process.env.HARNESS_WORKSPACE_ROOT;
    await assert.rejects(updatePlanReview({ root, planSetId: 'ticket-one', action: 'begin' }), /runner workspace and execution identity/);
    process.env.HARNESS_WORKSPACE_ROOT = workspaceRoot;
    assert.equal(JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-ticket-one.json'), 'utf8')).attempts.at(-1).status, 'aborted');
    const planAttempt = await updatePlanReview({ root, planSetId: 'ticket-one', action: 'begin' });
    assert.equal(planAttempt.reviewer_input_ref, `runtime/executions/review-stage/plan-review-admission-${planAttempt.attempt_id}.json`);
    const reviewerSnapshot = JSON.parse(await readFile(join(root, '.io', planAttempt.reviewer_input_ref), 'utf8'));
    assert.equal(reviewerSnapshot.attempt_id, planAttempt.attempt_id);
    assert.ok(reviewerSnapshot.files.some((file) => file.path === 'docs/plans/ticket-one/slice.md' && file.content.includes('# Slice')));
    const planInput = { ...input, tool_use_id: 'dispatch-plan', tool_input: { ...input.tool_input, subagent_type: 'plan_reviewer', prompt: 'Review the plans.' } };
    const admissionPath = join(root, '.io', planAttempt.reviewer_input_ref);
    const admissionContents = await readFile(admissionPath, 'utf8');
    reviewerSnapshot.files[0].content += '\nTampered after admission.\n';
    await writeFile(admissionPath, JSON.stringify(reviewerSnapshot));
    assert.equal(callAdmission(root, 'ticket-one', planInput).hookSpecificOutput.permissionDecision, 'deny');
    await writeFile(admissionPath, admissionContents);
    const planAllowed = callAdmission(root, 'ticket-one', planInput);
    assert.equal(planAllowed.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(planAllowed.hookSpecificOutput.updatedInput.prompt, /plan_set_id=ticket-one/);
    assert.ok(planAllowed.hookSpecificOutput.updatedInput.prompt.includes(`reviewer_input_ref=${planAttempt.reviewer_input_ref}`));
    assert.equal(callAdmission(root, 'ticket-one', input).hookSpecificOutput.permissionDecision, 'deny');
    callEvent(root, { hook_event_name: 'SubagentStart', session_id: 'claude-session', agent_id: 'native-plan-agent', agent_type: 'plan_reviewer' });
    const planNativeResult = JSON.stringify({ verdict: 'pass', findings: [] });
    callEvent(root, { hook_event_name: 'SubagentStop', session_id: 'claude-session', agent_id: 'native-plan-agent', agent_type: 'plan_reviewer', last_assistant_message: planNativeResult });
    planHistory = await inspectReviewHistory({ root, scope: planScope });
    const planReview = { reviewer_id: `claude-review-stage-${planAttempt.attempt_id}`, author_ids: ['to-ticket-author'], fork_turns: 'none', verdict: 'pass', findings: [] };
    process.env.HARNESS_SKILL_EXECUTION_ID = 'resumed-author';
    await writeFile(admissionPath, JSON.stringify(reviewerSnapshot));
    await assert.rejects(updatePlanReview({ root, planSetId: 'ticket-one', action: 'record', attemptId: planAttempt.attempt_id, review: planReview }), /admission contents/);
    await writeFile(admissionPath, admissionContents);
    await updatePlanReview({ root, planSetId: 'ticket-one', action: 'record', attemptId: planAttempt.attempt_id, review: planReview });
    await assert.rejects(updatePlanReview({ root, planSetId: 'ticket-one', action: 'begin' }), /unchanged/i);
    } finally {
      for (const [key, value] of Object.entries(runtimeEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
    assert.equal(planHistory.recorded_state, 'active');
    await assertNoUnrecordedNativeReview({ root, scope: planScope });
    assert.deepEqual(Object.keys(await snapshotPlanSet({ root, planSetId: 'ticket-one' })), ['plan_set_id', 'base', 'spec_paths', 'plans', 'inputs']);

    await mkdir(join(root, 'docs/specs/budget-ticket'), { recursive: true });
    const budgetSpec = join(root, 'docs/specs/budget-ticket/architecture-spec.md');
    await writeFile(join(root, 'docs/specs/budget-ticket/product-spec.md'), 'Status: approved\nBudget test requirements.\n');
    for (let round = 1; round <= 3; round++) {
      await writeFile(budgetSpec, `Status: approved\nArchitecture revision ${round}.\n`);
      const scope = 'spec-budget-ticket-architecture';
      const roundAdmission = await updateReviewAttempt({ root, scope, action: 'begin', inputs: await snapshotSpecReview({ root, ticketId: 'budget-ticket' }) });
      const reviewerId = `budget-reviewer-${round}`;
      const agentId = `budget-agent-${round}`;
      await updateReviewAttempt({ root, scope, action: 'claim', attemptId: roundAdmission.attempt_id, reviewerId, nativeAgentId: `pending-${round}`, parentSessionId: 'budget-session', executionId: `budget-exec-${round}` });
      await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: roundAdmission.attempt_id, nativeAgentId: agentId, parentSessionId: 'budget-session' });
      const findings = [{ severity: 'minor', description: 'Clarify a detail.', evidence: `Revision ${round}.` }];
      const nativeReview = { verdict: 'revise', findings };
      await updateReviewAttempt({ root, scope, action: 'stop-native', attemptId: roundAdmission.attempt_id, nativeAgentId: agentId, parentSessionId: 'budget-session', nativeResult: JSON.stringify(nativeReview), nativeReview });
      await updateReviewAttempt({ root, scope, action: 'record', attemptId: roundAdmission.attempt_id, inputs: roundAdmission.inputs, review: { axis: 'architecture', ticket_id: 'budget-ticket', reviewer_id: reviewerId, author_ids: [`author-${round}`], fork_turns: 'none', ...nativeReview } });
    }
    await writeFile(budgetSpec, 'Status: approved\nArchitecture revision after budget.\n');
    await assert.rejects(updateReviewAttempt({ root, scope: 'spec-budget-ticket-architecture', action: 'begin', inputs: await snapshotSpecReview({ root, ticketId: 'budget-ticket' }) }), /retry budget exhausted/i);

    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /docs\/contracts\/owned\.md/);
    assert.doesNotMatch(status, /\.harness\/src\/workflow\/providers\/claude-code\.mjs/);
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/providers/claude-code.mjs'], { cwd: root });
    execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-agent-admission.mjs'], { cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
