import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReviewAttempt, inspectReviewHistory, reviewAdmissionPreviousInputs, assertReviewAttempt, assertNoUnrecordedNativeReview } from '../.harness/src/workflow/review-attempts.mjs';
import { snapshotPlanSet } from '../.harness/src/workflow/plan-review.mjs';
import { reviewDelta } from '../.harness/src/workflow/review-delta.mjs';
import { executionStatus, isInterruption, reviewerLiveness, REVIEWER_BIND_GRACE_MS, REVIEWER_STALE_AFTER_MS, REVIEWER_TRANSCRIPT_LOOKUP_GRACE_MS } from '../.harness/src/workflow/review-liveness.mjs';

test('a missing transcript lookup cannot release a recently active reviewer at the stale boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-liveness-'));
  try {
    const started = new Date(Date.now() - REVIEWER_STALE_AFTER_MS - 1000).toISOString();
    const attempt = { native_review: { agent_id: 'reviewer', execution_id: 'exec', started_at: started, transcript_path: join(root, 'transcript.jsonl') } };
    const atBoundary = reviewerLiveness({ root, attempt, now: Date.now() });
    assert.equal(atBoundary.live, true);
    assert.equal(atBoundary.state, 'live');
    const beyondGrace = reviewerLiveness({ root, attempt, now: Date.now() + REVIEWER_TRANSCRIPT_LOOKUP_GRACE_MS + 2000 });
    assert.equal(beyondGrace.live, false);
    assert.equal(beyondGrace.state, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reviewer result arriving after interrupted lock release cannot be recorded as approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-interrupted-'));
  try {
    const inputs = { plan: 'v1' };
    const first = await updateReviewAttempt({ root, scope: 'plan-example', action: 'begin', inputs });
    await updateReviewAttempt({ root, scope: 'plan-example', action: 'claim', attemptId: first.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'dispatch', parentSessionId: 'parent', executionId: 'exec' });
    await updateReviewAttempt({ root, scope: 'plan-example', action: 'bind-native', attemptId: first.attempt_id, nativeAgentId: 'agent', parentSessionId: 'parent' });
    await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
    await writeFile(join(root, '.io/runtime/orchestrator/workflow.json'), JSON.stringify({ state: { stages: { review: { status: 'failed', execution_id: 'exec' } } } }));
    const interruption = await updateReviewAttempt({ root, scope: 'plan-example', action: 'mark-interrupted', attemptId: first.attempt_id, interruptedBy: 'write-guard' });
    assert.equal(interruption.reviewer_state, 'execution_terminal');
    const nativeReview = { verdict: 'pass', findings: [] };
    const nativeResult = JSON.stringify(nativeReview);
    await updateReviewAttempt({ root, scope: 'plan-example', action: 'stop-native', attemptId: first.attempt_id, nativeAgentId: 'agent', parentSessionId: 'parent', nativeResult, nativeReview });
    await assert.rejects(updateReviewAttempt({ root, scope: 'plan-example', action: 'record', attemptId: first.attempt_id, inputs, review: { ...nativeReview, reviewer_id: 'reviewer', author_ids: ['parent'], fork_turns: 'none' } }), /marked interrupted.*cannot be accepted/i);
    const next = await updateReviewAttempt({ root, scope: 'plan-example', action: 'begin', inputs });
    assert.equal(next.round, 2);
    const history = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-example.json'), 'utf8'));
    assert.equal(history.attempts[0].status, 'aborted');
    assert.equal(history.attempts[0].interrupted.reason, 'execution_terminal');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviewer liveness separates a normal stop from an interruption and reads each execution record shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-liveness-signals-'));
  try {
    const now = Date.now(), at = (ms) => new Date(now - ms).toISOString();
    const native = (extra = {}) => ({ native_review: { agent_id: 'agent', execution_id: 'exec', claimed_at: at(1000), started_at: at(1000), ...extra } });
    assert.equal(REVIEWER_STALE_AFTER_MS, 30 * 60 * 1000);
    assert.equal(REVIEWER_BIND_GRACE_MS, 5 * 60 * 1000);
    assert.deepEqual(['live', 'unclaimed'], [reviewerLiveness({ root, attempt: native(), now }).state, reviewerLiveness({ root, attempt: {}, now }).state]);
    // A stop is a release, not an interruption; a claim with no start, a silent bound reviewer and a terminal stage are.
    const stopped = reviewerLiveness({ root, attempt: native({ stopped: true, stopped_at: at(10) }), now });
    assert.deepEqual([stopped.live, stopped.state, isInterruption(stopped)], [false, 'stopped', false]);
    const unbound = reviewerLiveness({ root, attempt: { native_review: { execution_id: 'exec', claimed_at: at(REVIEWER_BIND_GRACE_MS + 1000) } }, now });
    assert.deepEqual([unbound.state, isInterruption(unbound)], ['unbound_stale', true]);
    assert.equal(reviewerLiveness({ root, attempt: { native_review: { execution_id: 'exec', claimed_at: at(REVIEWER_BIND_GRACE_MS - 1000) } }, now }).state, 'live');
    const silent = reviewerLiveness({ root, attempt: native({ claimed_at: at(REVIEWER_STALE_AFTER_MS + 1000), started_at: at(REVIEWER_STALE_AFTER_MS + 1000) }), now });
    assert.deepEqual([silent.state, isInterruption(silent)], ['stale', true]);
    assert.equal(reviewerLiveness({ root, attempt: native({ claimed_at: at(REVIEWER_STALE_AFTER_MS - 1000), started_at: at(REVIEWER_STALE_AFTER_MS - 1000) }), now }).state, 'live');
    assert.equal(reviewerLiveness({ root, attempt: { interrupted: { reason: 'stale' }, ...native() }, now }).state, 'interrupted', 'an earlier mark stays');
    assert.equal(reviewerLiveness({ root, attempt: native(), now: now + 1000 * 1000 }).state, 'live', 'clock skew inside the window');

    // The execution record is the workflow.json state or the older state.json; an earlier attempt of a stage counts too.
    assert.equal(executionStatus(root, 'exec'), null, 'no record');
    await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ stages: { 'to-ticket': { status: 'running', execution_id: 'now', attempts: [{ status: 'cancelled', execution_id: 'old' }] } } }));
    assert.deepEqual([executionStatus(root, 'now'), executionStatus(root, 'old'), executionStatus(root, 'other')], ['running', 'cancelled', null]);
    await writeFile(join(root, '.io/runtime/orchestrator/workflow.json'), JSON.stringify({ state: { stages: { 'to-ticket': { status: 'completed', execution_id: 'now' } } } }));
    assert.equal(executionStatus(root, 'now'), 'completed', 'workflow.json wins over state.json');
    for (const status of ['failed', 'cancelled', 'blocked', 'completed']) {
      await writeFile(join(root, '.io/runtime/orchestrator/workflow.json'), JSON.stringify({ state: { stages: { s: { status, execution_id: 'exec' } } } }));
      assert.equal(reviewerLiveness({ root, attempt: native(), now }).state, 'execution_terminal', status);
    }
    for (const status of ['running', 'waiting', 'pending']) {
      await writeFile(join(root, '.io/runtime/orchestrator/workflow.json'), JSON.stringify({ state: { stages: { s: { status, execution_id: 'exec' } } } }));
      assert.equal(reviewerLiveness({ root, attempt: native(), now }).live, true, status);
    }
    await writeFile(join(root, '.io/runtime/orchestrator/workflow.json'), 'not json');
    assert.equal(reviewerLiveness({ root, attempt: native(), now }).live, true, 'an unreadable record never releases a lock by itself');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mark-interrupted marks only a plan attempt whose reviewer is gone, once, and never touches a live or stopped one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-mark-'));
  try {
    const inputs = { plan: 'v1' }, scope = 'plan-example', file = join(root, '.io/runtime/reviews/plan-example.json');
    const mark = (attemptId) => updateReviewAttempt({ root, scope, action: 'mark-interrupted', attemptId, interruptedBy: 'write-guard' });
    const first = await updateReviewAttempt({ root, scope, action: 'begin', inputs });
    await assert.rejects(mark(first.attempt_id), /claimed reviewer/, 'an attempt without a reviewer has no lock to release');
    await updateReviewAttempt({ root, scope, action: 'claim', attemptId: first.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'dispatch', parentSessionId: 'parent', executionId: 'exec' });
    await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: first.attempt_id, nativeAgentId: 'agent', parentSessionId: 'parent', transcriptPath: join(root, 'agent.jsonl') });
    const bound = JSON.parse(await readFile(file, 'utf8')).attempts[0].native_review;
    assert.deepEqual([typeof bound.claimed_at, typeof bound.started_at, bound.transcript_path], ['string', 'string', join(root, 'agent.jsonl')]);
    const before = await readFile(file, 'utf8');
    const live = await mark(first.attempt_id);
    assert.deepEqual([live.interrupted, live.reviewer_state], [null, 'live']);
    assert.equal(await readFile(file, 'utf8'), before, 'a live reviewer leaves the history file untouched');
    await assert.rejects(mark('another-attempt'), /Only the active plan review attempt/);
    await assert.rejects(updateReviewAttempt({ root, scope: 'spec-example-architecture', action: 'mark-interrupted', attemptId: first.attempt_id, interruptedBy: 'x' }), /Only the active plan review attempt/);

    await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ stages: { review: { status: 'cancelled', execution_id: 'exec' } } }));
    const marked = await mark(first.attempt_id);
    assert.equal(marked.interrupted.reason, 'execution_terminal');
    assert.equal(marked.interrupted.detected_by, 'write-guard');
    assert.ok(marked.interrupted.detected_at && Object.hasOwn(marked.interrupted, 'last_activity_at'));
    const settled = await readFile(file, 'utf8');
    assert.deepEqual((await mark(first.attempt_id)).interrupted, marked.interrupted);
    assert.equal(await readFile(file, 'utf8'), settled, 'a second mark changes nothing');
    assert.equal((await inspectReviewHistory({ root, scope })).interrupted.reason, 'execution_terminal');

    // A reviewer that stopped normally is not marked, even when its stage execution has ended.
    const stoppedScope = 'plan-stopped', stoppedInputs = { plan: 'v2' };
    const second = await updateReviewAttempt({ root, scope: stoppedScope, action: 'begin', inputs: stoppedInputs });
    await updateReviewAttempt({ root, scope: stoppedScope, action: 'claim', attemptId: second.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'dispatch', parentSessionId: 'parent', executionId: 'exec' });
    await updateReviewAttempt({ root, scope: stoppedScope, action: 'bind-native', attemptId: second.attempt_id, nativeAgentId: 'agent-2', parentSessionId: 'parent' });
    const nativeReview = { verdict: 'pass', findings: [] };
    await updateReviewAttempt({ root, scope: stoppedScope, action: 'stop-native', attemptId: second.attempt_id, nativeAgentId: 'agent-2', parentSessionId: 'parent', nativeResult: JSON.stringify(nativeReview), nativeReview });
    const stopped = await updateReviewAttempt({ root, scope: stoppedScope, action: 'mark-interrupted', attemptId: second.attempt_id, interruptedBy: 'write-guard' });
    assert.deepEqual([stopped.interrupted, stopped.reviewer_state], [null, 'stopped']);
    assert.equal((await updateReviewAttempt({ root, scope: stoppedScope, action: 'record', attemptId: second.attempt_id, inputs: stoppedInputs, review: null, requireNative: true })).reason, 'pass');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only a plan review settles a vanished reviewer when the next review begins; other scopes keep their active attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-vanished-scope-'));
  try {
    await mkdir(join(root, '.io/runtime/orchestrator'), { recursive: true });
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ stages: { review: { status: 'failed', execution_id: 'exec' } } }));
    for (const scope of ['spec-example-architecture', 'plan-example']) {
      const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { plan: 'v1' } });
      await updateReviewAttempt({ root, scope, action: 'claim', attemptId: admission.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'dispatch', parentSessionId: 'parent', executionId: 'exec' });
      await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: admission.attempt_id, nativeAgentId: `agent-${scope}`, parentSessionId: 'parent' });
      if (scope.startsWith('spec-')) await assert.rejects(updateReviewAttempt({ root, scope, action: 'begin', inputs: { plan: 'v2' } }), /A review is already active/);
      else {
        const next = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { plan: 'v1' } });
        assert.equal(next.round, 2, 'the interrupted attempt is an aborted round and unchanged inputs may be reviewed again');
        const history = JSON.parse(await readFile(join(root, `.io/runtime/reviews/${scope}.json`), 'utf8'));
        assert.deepEqual([history.attempts[0].status, history.attempts[0].interrupted.detected_by, history.attempts[0].reason.startsWith('interrupted: ')], ['aborted', 'review-begin', true]);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    // Identity comes from the bound native reviewer: a stage-supplied author list is refused.
    await assert.rejects(updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review }), /author_ids is recorded from the native reviewer hook/);
    assert.equal((await updateReviewAttempt({ root, scope, action: 'record', attemptId: admission.attempt_id, inputs, review: null, requireNative: true })).reason, 'revise');
    const recorded = (await inspectReviewHistory({ root, scope })).last_review;
    assert.deepEqual({ reviewer_id: recorded.reviewer_id, author_ids: recorded.author_ids, fork_turns: recorded.fork_turns, verdict: recorded.verdict }, { reviewer_id: 'reviewer', author_ids: ['claude-session'], fork_turns: 'none', verdict: 'revise' });
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

test('a reviewer that finished after its stage was interrupted is settled when the next review begins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-interrupted-'));
  try {
    const scope = 'spec-ticket-architecture';
    const admission = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { spec: 'old' } });
    await updateReviewAttempt({ root, scope, action: 'claim', attemptId: admission.attempt_id, reviewerId: 'reviewer', nativeAgentId: 'token', parentSessionId: 'stage-session', executionId: 'review-stage' });
    await updateReviewAttempt({ root, scope, action: 'bind-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'stage-session' });
    const nativeReview = { verdict: 'revise', findings: [{ severity: 'major', description: 'gap', evidence: 'spec' }] };
    await updateReviewAttempt({ root, scope, action: 'stop-native', attemptId: admission.attempt_id, nativeAgentId: 'agent-1', parentSessionId: 'stage-session', nativeResult: JSON.stringify(nativeReview), nativeReview });
    // The stage was killed before record; the Spec changed afterwards.
    const next = await updateReviewAttempt({ root, scope, action: 'begin', inputs: { spec: 'new' } });
    assert.equal(next.round, 2);
    const history = JSON.parse(await readFile(join(root, `.io/runtime/reviews/${scope}.json`), 'utf8'));
    assert.equal(history.attempts.at(-2).status, 'stale');
    assert.equal(history.attempts.at(-2).settled_after_interruption, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

