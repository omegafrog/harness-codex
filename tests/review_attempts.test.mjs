import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReviewAttempt, inspectReviewHistory, reviewAdmissionPreviousInputs, assertReviewAttempt, assertNoUnrecordedNativeReview } from '../.harness/src/workflow/review-attempts.mjs';
import { snapshotPlanSet } from '../.harness/src/workflow/plan-review.mjs';
import { reviewDelta } from '../.harness/src/workflow/review-delta.mjs';

test('a fresh plan reviewer can review unchanged inputs after revise without discarding findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-retry-'));
  try {
    const scope = 'plan-example', inputs = { plan: 'v1' };
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    const finding = { severity: 'blocker', description: 'admission guidance mismatch', evidence: 'review input' };
    await updateReviewAttempt({ root, scope, action: 'record', attemptId: first.attempt_id, inputs, review: { verdict: 'revise', reviewer_id: 'reviewer-a', author_ids: ['author'], fork_turns: 'none', findings: [finding] } });
    const retry = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    assert.equal(retry.round, 2);
    assert.deepEqual(retry.previous_findings, [finding]);
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'record', attemptId: retry.attempt_id, inputs, review: { verdict: 'pass', reviewer_id: 'reviewer-a', author_ids: ['author'], fork_turns: 'none', findings: [] } }), /new reviewer/i);
    assert.equal((await updateReviewAttempt({ root, scope, action: 'record', attemptId: retry.attempt_id, inputs, review: { verdict: 'pass', reviewer_id: 'reviewer-b', author_ids: ['author'], fork_turns: 'none', findings: [] } })).status, 'pass');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan review tracks only its documents and ignores lifecycle status changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-scope-'));
  try {
    await mkdir(join(root, 'docs/plans/example'), { recursive: true });
    await mkdir(join(root, 'docs/specs/example'), { recursive: true });
    const write = (path, content) => writeFile(join(root, path), content);
    await write('docs/plans/example/plans.md', '# Plans\n');
    await write('docs/plans/example/one.md', '---\nstatus: planned\n---\n# Work\nOriginal\n');
    await write('docs/specs/example/product-spec.md', '# Product\n[Context](../../context.md)\n');
    await write('docs/specs/example/architecture-spec.md', '# Architecture\n');
    await write('docs/context.md', 'first');
    const first = await snapshotPlanSet({ root, planSetId: 'example' });
    assert.equal(Object.keys(first.inputs).length, 4);
    await reviewDelta({ root, inputs: first.inputs });
    await write('docs/context.md', 'changed');
    await write('docs/plans/example/one.md', '---\nstatus: in-progress\n---\n# Work\nOriginal\n');
    const statusOnly = await snapshotPlanSet({ root, planSetId: 'example' });
    assert.deepEqual(statusOnly.inputs, first.inputs);
    assert.deepEqual((await reviewDelta({ root, inputs: statusOnly.inputs, previousInputs: first.inputs })).changed, []);
    await write('docs/plans/example/one.md', '---\nstatus: in-progress\n---\n# Work\nChanged\n');
    const changed = await snapshotPlanSet({ root, planSetId: 'example' });
    assert.notEqual(changed.inputs['docs/plans/example/one.md'], first.inputs['docs/plans/example/one.md']);
    assert.equal((await reviewDelta({ root, inputs: changed.inputs, previousInputs: first.inputs })).changed[0].path, 'docs/plans/example/one.md');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only explicit pre-dispatch spec preparation aborts are outside the review retry budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-review-attempts-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'hash' };
    for (let i = 0; i < 3; i++) {
      const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
      const result = await updateReviewAttempt({ root, scope, action: 'abort', attemptId: admission.attempt_id, reason: 'pre-dispatch preparation: reviewer input unavailable' });
      assert.equal(result.round, 1);
    }
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'begin', inputs }), /preparation retry limit exhausted/);
    const status = await inspectReviewHistory({ root, scope });
    assert.equal(status.budget.used, 0);
    assert.equal(status.next_admission_requires_resolution, true);
    await updateReviewAttempt({ root, scope, action: 'resolve', reason: 'preparation recovery: reviewer launch configuration was repaired' });
    assert.equal((await updateReviewAttempt({ root, scope, action: 'begin', inputs })).round, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preparation aborts after a substantive attempt preserve its round and status budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-review-mixed-attempts-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'hash' };
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: first.attempt_id, reason: 'reviewer exited after dispatch' });
    const second = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: second.attempt_id, reason: 'pre-dispatch preparation: reviewer context unavailable' });
    assert.equal((await inspectReviewHistory({ root, scope })).budget.used, 1);
    assert.equal((await updateReviewAttempt({ root, scope, action: 'begin', inputs })).round, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pass at round two or three resets the next review to round one', async () => {
  for (const passRound of [2, 3]) {
    const root = await mkdtemp(join(tmpdir(), 'spec-review-pass-reset-'));
    try {
      const scope = 'spec-ticket-architecture';
      let inputs = { spec: 'v1' }, reviewer = 0;
      for (let round = 1; round <= passRound; round++) {
        const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
        assert.equal(admission.round, round);
        const verdict = round === passRound ? 'pass' : 'revise';
        const review = { verdict, reviewer_id: `reviewer-${++reviewer}`, author_ids: ['author'], fork_turns: 'none', inputs, findings: verdict === 'pass' ? [] : [{ severity: 'major', description: 'fix', evidence: 'spec section' }] };
        await updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review });
        inputs = { spec: `v${round + 1}` };
      }
      assert.equal((await inspectReviewHistory({ root, scope })).budget.used, 0);
      assert.equal((await updateReviewAttempt({ root, scope, action: 'begin', inputs })).round, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('review inputs and findings survive an intervening preparation abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-review-delta-history-'));
  try {
    const scope = 'spec-ticket-architecture', firstInputs = { spec: 'v1' };
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs: firstInputs });
    const finding = { severity: 'major', description: 'missing owner', evidence: 'architecture section' };
    await updateReviewAttempt({ root, scope, action: 'record', attemptId: first.attempt_id, inputs: firstInputs, review: { verdict: 'revise', reviewer_id: 'reviewer-a', author_ids: ['author'], fork_turns: 'none', inputs: firstInputs, findings: [finding] } });
    const secondInputs = { spec: 'v2' };
    const second = await updateReviewAttempt({ root, scope, action: 'begin', inputs: secondInputs });
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: second.attempt_id, reason: 'pre-dispatch preparation: reviewer execution unavailable' });
    const status = await inspectReviewHistory({ root, scope });
    assert.equal(status.recorded_state, 'revise');
    assert.equal(status.last_attempt_status, 'aborted');
    assert.deepEqual(status.findings, [finding]);
    const third = await updateReviewAttempt({ root, scope, action: 'begin', inputs: secondInputs });
    assert.deepEqual(third.previous_inputs, firstInputs);
    assert.deepEqual(third.previous_findings, [finding]);
    assert.deepEqual(await reviewAdmissionPreviousInputs({ root, scope, attemptId: third.attempt_id }), firstInputs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('substantive resolution remains active across a preparation abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-review-resolution-boundary-'));
  try {
    const scope = 'spec-ticket-architecture';
    let inputs = { spec: 'v1' };
    for (let round = 1; round <= 3; round++) {
      const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
      await updateReviewAttempt({ root, scope, action: 'abort', attemptId: admission.attempt_id, reason: 'reviewer exited after dispatch' });
      if (round < 3) inputs = { spec: `v${round + 1}` };
    }
    await updateReviewAttempt({ root, scope, action: 'resolve', reason: 'user narrowed the requested scope' });
    const restarted = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { spec: 'resolved' } });
    assert.equal(restarted.round, 1);
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: restarted.attempt_id, reason: 'pre-dispatch preparation: missing reviewer profile' });
    const again = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { spec: 'resolved' } });
    assert.equal(again.round, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-dispatch and unmarked legacy aborts continue to consume substantive rounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-attempts-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'hash' };
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: first.attempt_id, reason: 'reviewer exited after dispatch' });
    const second = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    assert.equal(second.round, 2);
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: second.attempt_id, reason: 'legacy abort' });
    const third = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    assert.equal(third.round, 3);
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: third.attempt_id, reason: 'legacy abort' });
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'begin', inputs }), /retry budget exhausted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan review abort accounting is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-attempts-'));
  try {
    const scope = 'plan-set', inputs = { plans: 'hash' };
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: first.attempt_id, reason: 'pre-dispatch preparation: reviewer setup failed' });
    assert.equal((await updateReviewAttempt({ root, scope, action: 'begin', inputs })).round, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review admission supplies the snapshot when reviewer returns only findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-admission-inputs-'));
  try {
    const scope = 'plan-example', inputs = { plan: 'original' };
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    const review = { verdict: 'pass', reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none', findings: [] };
    const result = await updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs: { plan: 'changed' }, review });
    assert.equal(result.reason, 'stale');
    assert.deepEqual((await inspectReviewHistory({ root, scope })).findings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recorded pass is required and caller metadata must match the complete recorded review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-attempt-authority-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'current' };
    const review = { verdict: 'pass', reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none', findings: [] };
    await assert.rejects(assertReviewAttempt({ root, scope, review }), /authoritative passing result/);
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review });
    const recorded = { ...review, inputs };
    await assertReviewAttempt({ root, scope, review: recorded });
    await assert.rejects(assertReviewAttempt({ root, scope, review: { ...recorded, findings: [{ severity: 'major', description: 'fabricated', evidence: 'elsewhere' }] } }), /authoritative passing result/);
    await assert.rejects(assertReviewAttempt({ root, scope, review: { ...recorded, verdict: 'revise' } }), /authoritative passing result/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native claim admits one reviewer and records only its bound stopped identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-native-claim-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'current' };
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'claim', attemptId: admission.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'pending-token', parentSessionId: 'claude-session', executionId: 'review-stage' });
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'claim', attemptId: admission.attempt_id, reviewerId: 'other', nativeAgentId: 'second-token', parentSessionId: 'claude-session', executionId: 'review-stage' }), /already claimed/);
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'other-session' }), /does not match its claim/);
    await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'claude-session' });
    const review = { verdict: 'pass', reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none', findings: [] };
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review }), /claimed, stopped native reviewer/);
    const nativeReview = { verdict: 'revise', findings: [{ severity: 'major', description: 'missing evidence', evidence: 'review output' }] };
    const nativeResult = JSON.stringify(nativeReview);
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'stop-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'other-session', nativeResult, nativeReview }), /does not match its active claim/);
    await updateReviewAttempt({ root, scope, action: 'stop-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'claude-session', nativeResult, nativeReview });
    await assert.rejects(assertNoUnrecordedNativeReview({ root, scope }), /must be recorded/);
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review }), /claimed, stopped native reviewer result/);
    const revise = { ...review, ...nativeReview };
    assert.equal((await updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review: revise })).reason, 'revise');
    await assertNoUnrecordedNativeReview({ root, scope });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a claimed native dispatch cannot use the pre-dispatch abort exemption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-native-abort-budget-'));
  try {
    const scope = 'spec-ticket-architecture', inputs = { spec: 'current' };
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await updateReviewAttempt({ root, scope, action: 'claim', attemptId: admission.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'pending-token', parentSessionId: 'claude-session', executionId: 'review-stage' });
    await assert.rejects(assertNoUnrecordedNativeReview({ root, scope }), /active native review must be recorded or aborted/i);
    await updateReviewAttempt({ root, scope, action: 'abort', attemptId: admission.attempt_id, reason: 'pre-dispatch preparation: claimed agent failed to start' });
    await assertNoUnrecordedNativeReview({ root, scope });
    assert.equal((await inspectReviewHistory({ root, scope })).budget.used, 1);
    assert.equal((await updateReviewAttempt({ root, scope, action: 'begin', inputs })).round, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
