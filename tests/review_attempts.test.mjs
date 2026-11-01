import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReviewAttempt, inspectReviewHistory, reviewAdmissionPreviousInputs } from '../src/workflow/review-attempts.mjs';

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
