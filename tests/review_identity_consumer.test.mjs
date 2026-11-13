import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

// Installed consumer: a stage cannot write its own reviewer identity. The subagent hook (shared by
// Codex and Claude Code) binds the native reviewer, and only then does `record` accept the review.
test('installed plan review records reviewer identity only from the subagent hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-review-identity-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await mkdir(join(root, 'docs/plans/sample'), { recursive: true });
    await mkdir(join(root, 'docs/specs/sample'), { recursive: true });
    await writeFile(join(root, 'docs/plans/sample/plans.md'), '- Product Spec: `docs/specs/sample/product-spec.md`\n- Architecture Spec: `docs/specs/sample/architecture-spec.md`\n- [plan](slice.md)\n');
    await writeFile(join(root, 'docs/plans/sample/slice.md'), '---\nstatus: planned\n---\n# Slice\n');
    await writeFile(join(root, 'docs/specs/sample/product-spec.md'), '# Product\n');
    await writeFile(join(root, 'docs/specs/sample/architecture-spec.md'), '# Architecture\n');
    const env = { ...process.env, HARNESS_WORKSPACE_ROOT: root, HARNESS_SKILL_EXECUTION_ID: 'to-ticket-exec-1', HARNESS_SESSION_DIR: join(root, '.io'), HARNESS_REVIEW_TICKET_ID: 'sample', HARNESS_REVIEW_EXECUTION_ID: 'to-ticket-exec-1' };
    const cli = join(root, '.codex/scripts/harness-plan-review.mjs');
    const run = (args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--plan-set', 'sample'], { cwd: root, encoding: 'utf8', env });
    const begin = JSON.parse(run(['begin']).stdout);

    await mkdir(join(root, '.io/runtime/reviews'), { recursive: true });
    await writeFile(join(root, '.io/runtime/reviews/self.json'), JSON.stringify({ schema_version: 1, attempt_id: begin.attempt_id, plan_set_id: 'sample', reviewer_id: 'self-declared', author_ids: ['author'], fork_turns: 'none', verdict: 'pass', findings: [] }));
    const selfDeclared = run(['record', '--attempt', begin.attempt_id, '--reviews', 'runtime/reviews/self.json']);
    assert.notEqual(selfDeclared.status, 0);
    assert.match(selfDeclared.stderr, /must not supply reviewer_id, author_ids, fork_turns, verdict, findings; they are recorded from the native reviewer hook/);
    assert.notEqual(run(['record', '--attempt', begin.attempt_id]).status, 0, 'no hook-bound reviewer yet');

    const hook = (event) => execFileSync(process.execPath, [join(root, '.codex/scripts/harness-agent-event.mjs')], { cwd: root, env, input: JSON.stringify({ session_id: 'to-ticket-thread', agent_type: 'plan_reviewer', ...event }) });
    // A forked reviewer (inherits the author's conversation) is logged but never bound.
    const forkedTranscript = join(root, '.io/forked-rollout.jsonl');
    await writeFile(forkedTranscript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'forked-reviewer', forked_from_id: 'to-ticket-thread' } })}\n`);
    hook({ hook_event_name: 'SubagentStart', agent_id: 'forked-reviewer', agent_transcript_path: forkedTranscript });
    assert.notEqual(run(['record', '--attempt', begin.attempt_id]).status, 0, 'a forked reviewer cannot pass the review');

    hook({ hook_event_name: 'SubagentStart', agent_id: 'native-plan-reviewer-1' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'native-plan-reviewer-1', last_assistant_message: JSON.stringify({ verdict: 'pass', findings: [] }) });
    const recorded = run(['record', '--attempt', begin.attempt_id]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const history = JSON.parse(await readFile(join(root, '.io/runtime/reviews/plan-sample.json'), 'utf8'));
    const review = history.attempts.at(-1).review;
    assert.deepEqual({ reviewer_id: review.reviewer_id, author_ids: review.author_ids, fork_turns: review.fork_turns, verdict: review.verdict }, { reviewer_id: 'native-plan-reviewer-1', author_ids: ['to-ticket-thread'], fork_turns: 'none', verdict: 'pass' });
    const events = (await readFile(join(root, '.io/runtime/executions/to-ticket-exec-1/subagents.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((item) => [item.agent_id, item.event, item.admitted ?? true, item.forked ?? false]), [
      ['forked-reviewer', 'SubagentStart', false, true],
      ['native-plan-reviewer-1', 'SubagentStart', true, false],
      ['native-plan-reviewer-1', 'SubagentStop', true, false],
    ]);
    assert.equal(JSON.parse(run(['check', '--phase', 'planning']).stdout).details.review_attempt_id, begin.attempt_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stage completes only when an admitted fresh reviewer finished after any rogue reviewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-rogue-reviewer-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const { assertNoRogueReviewer } = await import(`file://${join(root, '.harness/src/workflow/skill-execution.mjs')}`);
    const session = join(root, '.io'), input = { execution_id: 'spec-me-1' };
    const write = async (events) => { await mkdir(join(session, 'runtime/executions/spec-me-1'), { recursive: true }); await writeFile(join(session, 'runtime/executions/spec-me-1/subagents.jsonl'), events.map((item) => JSON.stringify({ review_scope: 'spec-x-architecture', ...item })).join('\n') + '\n'); };
    await assertNoRogueReviewer({ root, session, input }); // no reviewers at all
    await write([{ event: 'SubagentStart', agent_id: 'forked', admitted: false, forked: true }]);
    await assert.rejects(assertNoRogueReviewer({ root, session, input }), /Reviewer forked ran forked from the author conversation after the last admitted review/);
    await write([{ event: 'SubagentStart', agent_id: 'forked', admitted: false, forked: true }, { event: 'SubagentStart', agent_id: 'fresh', review_attempt_id: 'a1' }, { event: 'SubagentStop', agent_id: 'fresh', review_attempt_id: 'a1' }]);
    await assertNoRogueReviewer({ root, session, input });
    await write([{ event: 'SubagentStop', agent_id: 'fresh', review_attempt_id: 'a1' }, { event: 'SubagentStart', agent_id: 'late', admitted: false }]);
    await assert.rejects(assertNoRogueReviewer({ root, session, input }), /outside an admitted review attempt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembled implementation review evidence passes the repair provenance check', async () => {
  const { reviewInputFromParts, assembleReviews } = await import('../.harness/src/wrapper/review-input.mjs');
  const { validReviewProvenance } = await import('../.harness/src/wrapper/repair.mjs');
  const details = { product_spec_path: 'docs/specs/p/product-spec.md', architecture_spec_path: 'docs/specs/p/architecture-spec.md', review_snapshot_sha256: 'a'.repeat(64), canonical_plan: { kind: 'file', reference: 'docs/plans/p/A.md', input_key: 'docs/plans/p/A.md#canonical', hash_algorithm: 'sha256', normalization: 'frontmatter-status-excluded-v1', sha256: 'b'.repeat(64) } };
  const reviewInput = reviewInputFromParts({ root: '/w', fixed: 'f'.repeat(40), implementation: 'c'.repeat(40), between: ['c'.repeat(40)], diff: 'diff --git a b\n+x\n', unplannedAdditions: [], planSetId: 'p', details });
  assert.deepEqual(reviewInput.diff_range, { from: 'f'.repeat(40), to: 'c'.repeat(40) });
  assert.deepEqual(reviewInput.commit_list, ['f'.repeat(40), 'c'.repeat(40)]);
  const answer = JSON.stringify({ state: 'passed', report: { findings: [] } });
  const evidence = assembleReviews({ reviewInput, standards: { contextId: 'native-standards-1', raw: answer }, spec: { contextId: 'native-spec-1', raw: answer } });
  assert.equal(validReviewProvenance(evidence.reviews, reviewInput.implementation_commit_sha, reviewInput), true);
  const { buildReviewInput, readImplementerResult } = await import('../.harness/src/wrapper/review-input.mjs');
  await assert.rejects(buildReviewInput({ root: '/w', planId: 'A', fixedPoint: 'f'.repeat(40), unplannedAdditions: [] }), /implementation commit SHA .* is required/);
  assert.equal(typeof readImplementerResult, 'function');
  assert.throws(() => assembleReviews({ reviewInput, standards: { contextId: '', raw: answer }, spec: { contextId: 'x', raw: answer } }), /native context ID/);
  assert.throws(() => assembleReviews({ reviewInput, standards: { contextId: 's', raw: 'not json' }, spec: { contextId: 'x', raw: answer } }), /not JSON/);
  // The caller's hand-built shape that failed in the E2E (string diff_range, commit_list without the fixed point) stays invalid.
  const handBuilt = { ...reviewInput, diff_range: `${reviewInput.fixed_point}..${reviewInput.implementation_commit_sha}`, commit_list: [reviewInput.implementation_commit_sha] };
  assert.equal(validReviewProvenance(evidence.reviews.map((item) => ({ ...item, review_input: handBuilt })), reviewInput.implementation_commit_sha, handBuilt), false);
});

test('orchestrator-session code reviewers are recorded by the hook and assemble reads them from there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-orchestrator-reviewers-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const session = join(root, '.io');
    await mkdir(session, { recursive: true });
    await writeFile(join(session, 'worktree.json'), JSON.stringify({ state: 'active', session_directory: session }));
    const hookScript = join(root, '.codex/scripts/harness-agent-event.mjs');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HARNESS_')));
    const hook = (event) => execFileSync(process.execPath, [hookScript], { cwd: root, env, input: JSON.stringify({ cwd: root, session_id: 'orchestrator-thread', ...event }) });
    const answer = JSON.stringify({ state: 'passed', report: { findings: [] } });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'standards-1', agent_type: 'standards_reviewer' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'standards-1', agent_type: 'standards_reviewer', last_assistant_message: answer });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'spec-1', agent_type: 'spec_reviewer' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'spec-1', agent_type: 'spec_reviewer', last_assistant_message: answer });
    // Other subagents and sessions outside a worktree are ignored.
    hook({ hook_event_name: 'SubagentStart', agent_id: 'writer-1', agent_type: 'code_researcher' });
    const forkedTranscript = join(session, 'forked.jsonl');
    await writeFile(forkedTranscript, `${JSON.stringify({ payload: { forked_from_id: 'orchestrator-thread' } })}\n`);
    hook({ hook_event_name: 'SubagentStart', agent_id: 'spec-forked', agent_type: 'spec_reviewer', agent_transcript_path: forkedTranscript });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'spec-forked', agent_type: 'spec_reviewer', last_assistant_message: answer });
    // Codex may fire SubagentStart before the forked transcript is written; the fork is caught when the reviewer stops.
    const lateTranscript = join(session, 'late-forked.jsonl');
    hook({ hook_event_name: 'SubagentStart', agent_id: 'spec-late-fork', agent_type: 'spec_reviewer', agent_transcript_path: lateTranscript });
    await writeFile(lateTranscript, `${JSON.stringify({ payload: { forked_from_id: 'orchestrator-thread' } })}\n`);
    hook({ hook_event_name: 'SubagentStop', agent_id: 'spec-late-fork', agent_type: 'spec_reviewer', agent_transcript_path: lateTranscript, last_assistant_message: answer });
    const log = (await readFile(join(session, 'runtime/orchestrator/subagents.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(log.map((item) => item.agent_id), ['standards-1', 'standards-1', 'spec-1', 'spec-1', 'spec-forked', 'spec-forked', 'spec-late-fork', 'spec-late-fork']);
    const { readHookRecordedReviewer } = await import(`file://${join(root, '.harness/src/wrapper/review-input.mjs')}`);
    assert.deepEqual(await readHookRecordedReviewer({ root, role: 'standards', agentId: 'standards-1' }), { contextId: 'standards-1', raw: answer });
    await assert.rejects(readHookRecordedReviewer({ root, role: 'spec', agentId: 'spec-forked' }), /forked from the caller's conversation/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'spec', agentId: 'spec-late-fork' }), /forked from the caller's conversation/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', agentId: 'invented-id' }), /did not record a finished standards_reviewer/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', agentId: 'spec-1' }), /did not record a finished standards_reviewer/);
    // Without an ID, the single reviewer of each type that finished after the result is used; a mistyped ID names the recorded ones.
    assert.deepEqual(await readHookRecordedReviewer({ root, role: 'standards' }), { contextId: 'standards-1', raw: answer });
    assert.deepEqual(await readHookRecordedReviewer({ root, role: 'spec' }), { contextId: 'spec-1', raw: answer }, 'a forked reviewer is never picked');
    hook({ hook_event_name: 'SubagentStart', agent_id: 'standards-2', agent_type: 'standards_reviewer' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'standards-2', agent_type: 'standards_reviewer', last_assistant_message: answer });
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards' }), /Several standards_reviewers finished after the implementation result \(standards-1, standards-2\)/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', after: Date.now() + 60000 }), /recorded no standards_reviewer that finished after/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', agentId: 'standards-l' }), /recorded: standards-1, standards-2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orchestrator-relayed scope decisions answer only a question the latest repair asked, with words the user said after it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-scope-decision-'));
  const primary = join(parent, 'primary'), root = join(parent, 'worktree');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    await mkdir(primary);
    execFileSync('git', ['init', '-q', '-b', 'main', primary]);
    execFileSync('git', ['-C', primary, '-c', 'user.name=Harness Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'feature/decision', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await mkdir(join(root, '.io/runtime/reviews'), { recursive: true });
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, worktree_id: 'c5c669a2-2967-4831-98db-63a24954e857', workspace: root, common: join(primary, '.git'), return_root: primary, session_directory: join(root, '.io'), branch: 'feature/decision', state: 'active', plan_set_id: 'sample', agent_sessions: { orchestrator: { provider: 'codex', session_id: 'c5c669a2-2967-4831-98db-63a24954e857', execution_id: 'compose-1' } } }));
    await writeFile(join(root, '.io/runtime/reviews/implementation-A-evidence.json'), JSON.stringify({ review_input: {}, reviews: [] }));
    const cli = join(root, '.codex/scripts/harness-code-review.mjs');
    const run = (...args) => spawnSync(process.execPath, [cli, 'record-decision', '--root', root, '--plan', 'A', ...args], { cwd: root, encoding: 'utf8' });
    const { recordPendingQuestions } = await import(`file://${join(root, '.harness/src/wrapper/review-input.mjs')}`);
    const { findingFingerprint } = await import(`file://${join(root, '.harness/src/wrapper/repair.mjs')}`);
    const userSays = (prompt) => spawnSync(process.execPath, [join(root, '.codex/scripts/harness-orchestrator-hook.mjs')], { cwd: root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 'c5c669a2-2967-4831-98db-63a24954e857', prompt }) });

    // An earlier round's user answer exists, but nothing was asked in this round yet.
    userSays('Spec에 추가');
    assert.match(run('--finding', 'F-1', '--choice', 'adopt', '--answer', 'Spec에 추가').stderr, /not a question the latest repair asked/);

    // repair asks about F-1; the user has not answered since, so the earlier answer cannot be reused.
    const today = { reviewer_role: 'standards', kind: 'test_defect', summary: 'integration tests mixed into unit tests', evidence: 'identity/tests/test_identity.py:40' };
    const [question] = await recordPendingQuestions({ root, planId: 'A', questions: [{ finding_id: 'F-1', finding_ids: ['F-1'], fingerprints: [findingFingerprint(today)], question: { title: 't' } }], now: new Date(Date.now() + 1000) });
    assert.match(question.question_id, /^scope-A:F-1@[0-9a-f]{12}$/);
    assert.match(run('--finding', 'F-1', '--choice', 'adopt', '--answer', 'Spec에 추가').stderr, /No user message after the question/);
    const wrong = run('--finding', 'F-1', '--choice', 'adopt', '--answer', '지적 기각');
    assert.match(wrong.stderr, /must contain the chosen option label/);

    // The user answers after the question: the decision is recorded with the finding's fingerprint.
    await new Promise((done) => setTimeout(done, 1100));
    userSays('Spec에 추가'); // the placeholder worktree.json fails later hook steps; the input is recorded first
    const ok = run('--finding', 'F-1', '--choice', 'adopt', '--answer', 'Spec에 추가');
    assert.equal(ok.status, 0, ok.stderr);
    const evidence = JSON.parse(await readFile(join(root, '.io/runtime/reviews/implementation-A-evidence.json'), 'utf8'));
    assert.deepEqual(evidence.scope_decisions, [{ finding_id: 'F-1', choice: 'adopt', question_id: question.question_id, answers_ref: 'runtime/reviews/implementation-A-answers.json', fingerprints: [findingFingerprint(today)] }]);
    assert.equal((await readFile(join(root, '.io/runtime/orchestrator/user-inputs.jsonl'), 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a recorded decision does not apply to a different finding that reuses the same ID', async () => {
  const { classifyReviewFindings, findingFingerprint } = await import('../.harness/src/wrapper/repair.mjs');
  const yesterday = { id: 'P-STD-001', kind: 'scope_expansion', severity: 'major', summary: 'test asserts a framework save call', evidence: 'a.py:34' };
  const today = { ...yesterday, summary: 'integration tests mixed into unit tests', evidence: 'a.py:40' };
  const review = (finding) => [{ role: 'standards', state: 'failed', report: { findings: [finding] } }, { role: 'spec', state: 'passed', report: { findings: [] } }];
  const decision = { finding_id: 'P-STD-001', choice: 'reject', question_id: 'q', answers_ref: 'a', fingerprints: [findingFingerprint({ ...yesterday, reviewer_role: 'standards' })] };
  assert.equal(classifyReviewFindings(review(yesterday), { scopeDecisions: [decision] }).dismissed.length, 1, 'the answered finding is dismissed');
  const reused = classifyReviewFindings(review(today), { scopeDecisions: [decision] });
  assert.equal(reused.dismissed.length, 0, 'a new finding under the same ID is not covered by the earlier answer');
  assert.ok(reused.blockers.some((item) => item.id === 'P-STD-001' && !item.scope_decision));
  const { verifiedScopeDecisionsForTest } = await import('../.harness/src/wrapper/repair.mjs');
  assert.deepEqual(await verifiedScopeDecisionsForTest('/nonexistent', [{ finding_id: 'P-STD-001', choice: 'adopt', question_id: 'scope-P:P-STD-001', answers_ref: 'a.json' }]), [], 'a legacy decision without fingerprints is asked again');
});

test('a re-check result without a new commit is reviewed at the commit an earlier implementation result recorded', async () => {
  const { readImplementerResult } = await import('../.harness/src/wrapper/review-input.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-recheck-commit-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    for (const [id, result] of [['implement-wrapper-1', { unplanned_additions: [], commit_sha: sha }], ['implement-wrapper-2', { unplanned_additions: [] }]]) {
      await mkdir(join(root, '.io/runtime/executions', id), { recursive: true });
      await writeFile(join(root, '.io/runtime/executions', id, 'result.json'), JSON.stringify(result));
    }
    const resultRef = 'runtime/executions/implement-wrapper-2/result.json';
    assert.equal((await readImplementerResult({ root, resultRef })).commitSha, sha, 'the latest recorded commit is used while it is HEAD');
    assert.equal((await readImplementerResult({ root, resultRef, commit: sha.slice(0, 8) })).commitSha, sha, 'a unique prefix is enough');
    await assert.rejects(readImplementerResult({ root, resultRef, commit: sha.slice(0, 39).replace(/.$/, (c) => c === '0' ? '1' : '0') }), /No implement-wrapper result in this session recorded a commit starting with/);
    await assert.rejects(readImplementerResult({ root, resultRef, commit: 'zz' }), /is not a commit SHA/);
    git('commit', '-q', '--allow-empty', '-m', 'later plan');
    await assert.rejects(readImplementerResult({ root, resultRef }), /is not HEAD; pass --commit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review evidence and review history use separate files, and an overwritten history starts over', async () => {
  const { writeReviewEvidence } = await import('../.harness/src/wrapper/review-input.mjs');
  const { inspectReviewHistory } = await import('../.harness/src/workflow/review-attempts.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-evidence-path-'));
  try {
    assert.equal(await writeReviewEvidence({ root, planId: 'P', evidence: { review_input: {}, reviews: [] } }), 'runtime/reviews/implementation-P-evidence.json');
    // A history file that an earlier assemble overwrote with evidence no longer blocks every later review.
    await writeFile(join(root, '.io/runtime/reviews/implementation-P.json'), JSON.stringify({ review_input: {}, reviews: [] }));
    assert.equal((await inspectReviewHistory({ root, scope: 'implementation-P' })).recorded_state, 'no-current-reservation');
    // Evidence still at the old path is read until the new file exists.
    const { carryForwardReview } = await import('../.harness/src/wrapper/review-input.mjs');
    await rm(join(root, '.io/runtime/reviews/implementation-P-evidence.json'));
    await assert.rejects(carryForwardReview({ root, planId: 'P', role: 'standards', reviewInput: { fixed_point: 'x' } }), /earlier review is incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviewed reports when HEAD still needs a review, and the CLI accepts --flag=value', async () => {
  const { reviewedCommit } = await import('../.harness/src/wrapper/review-input.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-reviewed-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'one');
    assert.equal((await reviewedCommit({ root, planId: 'P' })).reason, 'no_passed_review');
    await mkdir(join(root, '.io/runtime/reviews'), { recursive: true });
    await writeFile(join(root, '.io/runtime/reviews/implementation-P-evidence.json'), JSON.stringify({ review_input: {}, reviews: [], passed: { implementation_commit_sha: 'b'.repeat(40) } }));
    assert.equal((await reviewedCommit({ root, planId: 'P' })).reason, 'commit_changed');
    const cli = fileURLToPath(new URL('../.codex/scripts/harness-code-review.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [cli, 'record-decision', `--root=${root}`, '--plan=P', '--finding=F', '--choice=reject', '--answer=지적 기각'], { encoding: 'utf8' });
    assert.match(run.stderr, /not a question the latest repair asked/, 'inline values are parsed');
    assert.match(spawnSync(process.execPath, [cli, 'repair', '--bogus', 'x'], { encoding: 'utf8' }).stderr, /Invalid code-review argument --bogus/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a review can survive unrelated plan changes, but not changed or missing plan and spec inputs', async () => {
  const { unchangedReviewScope } = await import('../.harness/src/wrapper/review-input.mjs');
  const prior = { product: 'p', architecture: 'a', plan: 'x', other: 'before' };
  const snapshot = { spec_paths: ['product', 'architecture'], inputs: { ...prior, other: 'after' } };
  const plan = { reference: 'plan', sha256: 'x' };
  assert.equal(unchangedReviewScope(prior, snapshot, plan, plan), true);
  for (const path of ['product', 'architecture', 'plan']) {
    assert.equal(unchangedReviewScope(prior, { ...snapshot, inputs: { ...snapshot.inputs, [path]: 'changed' } }, plan, plan), false);
  }
  assert.equal(unchangedReviewScope(null, snapshot, plan, plan), false);
  assert.equal(unchangedReviewScope(prior, snapshot, plan, { sha256: 'changed' }), false);
});

test('review input lookup only accepts a passing historical snapshot', async () => {
  const { passedReviewInputs } = await import('../.harness/src/workflow/review-attempts.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-passed-inputs-'));
  try {
    const inputs = { plan: 'a', spec: 'b' };
    const hash = createHash('sha256').update(JSON.stringify(Object.keys(inputs).sort().map((key) => [key, inputs[key]]))).digest('hex');
    await mkdir(join(root, '.io/runtime/reviews'), { recursive: true });
    const file = join(root, '.io/runtime/reviews/plan-p.json');
    const attempt = { round: 1, status: 'pass', inputs, review: { verdict: 'pass', findings: [] } };
    await writeFile(file, JSON.stringify({ attempts: [attempt] }));
    assert.deepEqual(await passedReviewInputs({ root, scope: 'plan-p', snapshot: hash }), inputs);
    assert.equal(await passedReviewInputs({ root, scope: 'plan-p', snapshot: '0'.repeat(64) }), null);
    attempt.status = 'stale';
    await writeFile(file, JSON.stringify({ attempts: [attempt] }));
    assert.equal(await passedReviewInputs({ root, scope: 'plan-p', snapshot: hash }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
