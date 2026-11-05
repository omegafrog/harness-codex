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
