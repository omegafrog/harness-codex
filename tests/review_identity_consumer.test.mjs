import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const log = (await readFile(join(session, 'runtime/orchestrator/subagents.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(log.map((item) => item.agent_id), ['standards-1', 'standards-1', 'spec-1', 'spec-1', 'spec-forked', 'spec-forked']);
    const { readHookRecordedReviewer } = await import(`file://${join(root, '.harness/src/wrapper/review-input.mjs')}`);
    assert.deepEqual(await readHookRecordedReviewer({ root, role: 'standards', agentId: 'standards-1' }), { contextId: 'standards-1', raw: answer });
    await assert.rejects(readHookRecordedReviewer({ root, role: 'spec', agentId: 'spec-forked' }), /forked from the caller's conversation/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', agentId: 'invented-id' }), /did not record a finished standards_reviewer/);
    await assert.rejects(readHookRecordedReviewer({ root, role: 'standards', agentId: 'spec-1' }), /did not record a finished standards_reviewer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
