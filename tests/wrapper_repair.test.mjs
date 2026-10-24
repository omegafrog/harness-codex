import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionDirectory } from '../src/workflow/session-output.mjs';

import {
  classifyReviewFindings,
  planRepairRound,
  runBoundedReviewRepair,
  reserveImplementationRepair,
} from "../src/wrapper/repair.mjs";

const REVIEW_INPUT = {
  repository: "/workspace/repo",
  fixed_point: "base-1",
  implementation_commit_sha: "impl-1",
  commit_list: ["base-1", "impl-1"],
  diff_range: { from: "base-1", to: "impl-1" },
  diff: "diff --git a/src/a b/src/a",
  product_spec_path: "docs/specs/496/product-spec.md",
  architecture_spec_path: "docs/specs/496/architecture-spec.md",
};

test('implementation repair budget survives re-entry and replacement worktrees', async () => {
  const base = await mkdtemp(join(sessionDirectory(process.cwd()), 'tmp-implementation-review-'));
  const root = join(base, 'root'), linked = join(base, 'linked');
  await mkdir(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
    git('worktree', 'add', '-qb', 'linked', linked);
    const make = (repository, sha) => {
      const reviewInput = { ...REVIEW_INPUT, repository, implementation_commit_sha: sha, commit_list: ['base-1', sha], diff_range: { from: 'base-1', to: sha } };
      const reviews = ['standards', 'spec'].map((role) => ({ role, state: role === 'standards' ? 'failed' : 'passed', independent: true, fresh_context: true, context_id: `${role}-${sha}`, implementation_commit_sha: sha, review_input: reviewInput, report: { findings: role === 'standards' ? [{ kind: 'implementation_defect', summary: 'Fix all request and recovery paths' }] : [] } }));
      return { root: repository, planId: 'plan-a', reviewInput, reviews };
    };
    const first = await reserveImplementationRepair(make(root, 'impl-1'));
    assert.equal(first.round, 1);
    await assert.rejects(reserveImplementationRepair(make(root, 'impl-1')), /already has a reserved repair/);
    await assert.rejects(reserveImplementationRepair({ ...make(linked, 'impl-2'), maxRounds: 2 }), /budget exhausted/);
    await reserveImplementationRepair({ root: linked, planId: 'plan-a', resolution: 'User changed the approved recovery scope; request.md:19' });
    assert.equal((await reserveImplementationRepair(make(linked, 'impl-2'))).round, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('only explicit advisory and integration contract sync findings are nonblocking', () => {
  const reviews = ['standards', 'spec'].map((role) => ({ role, state: 'passed', independent: true, fresh_context: true, context_id: role, implementation_commit_sha: 'impl-1', report: { findings: [] } }));
  reviews[0].report.findings.push({ kind: 'contract_sync', severity: 'minor', disposition: 'integration_deferred', completion_kind: 'feature_implemented', summary: 'Seal at final integration', evidence: 'docs/contracts/manifest.json:1 / snapshot-only drift' });
  reviews[1].report.findings.push({ kind: 'advisory', severity: 'minor', blocking: false, summary: 'Optional simplification', evidence: 'src/a:1' });
  assert.equal(planRepairRound({ reviews }).action, 'complete');
  reviews[0].report.findings[0].severity = 'major';
  assert.equal(planRepairRound({ reviews }).action, 'block');
  reviews[0].report.findings[0].kind = 'implementation_defect';
  assert.equal(planRepairRound({ reviews }).action, 'repair');
});

test('a correction rejects follow-up reviews in the previous reviewer contexts', async () => {
  const reviewsFor = (input) => ['standards', 'spec'].map((role) => ({ role, state: input.implementation_commit_sha === 'impl-1' && role === 'standards' ? 'failed' : 'passed', independent: true, fresh_context: true, context_id: role, implementation_commit_sha: input.implementation_commit_sha, review_input: input, report: { findings: input.implementation_commit_sha === 'impl-1' && role === 'standards' ? [{ kind: 'implementation_defect', summary: 'Fix the replay path' }] : [] } }));
  const result = await runBoundedReviewRepair({
    plan: { id: 'plan-a' }, initialImplementation: { commit_sha: 'impl-1' }, initialReviews: reviewsFor(REVIEW_INPUT), reviewInput: REVIEW_INPUT,
    dispatchRepair: async () => ({ plan_id: 'plan-a', commit_sha: 'impl-2', diff: REVIEW_INPUT.diff, commit_list: ['base-1', 'impl-1', 'impl-2'], fresh_context: true, empty_context: true }),
    runReviewers: async ({ review_input }) => reviewsFor(review_input),
  });
  assert.equal(result.reason, 'reviewer_isolation_violation');
});

test("review findings classify only bounded implementation repairs as repairable", () => {
  const result = classifyReviewFindings([
    { role: "standards", state: "failed", report: { findings: [
      { id: "impl-1", kind: "implementation_defect", summary: "Null handling is incorrect." },
      { id: "test-1", kind: "test_defect", summary: "Missing regression assertion." },
    ] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1" },
    { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1" },
  ]);

  assert.equal(result.repairable.length, 2);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.repairable.map(({ kind }) => kind), ["implementation_defect", "test_defect"]);
});

test("ambiguity, architecture, scope, and spec conflicts are immediate blockers", () => {
  const result = classifyReviewFindings([
    { role: "spec", state: "failed", report: { findings: [
      { kind: "requirement_ambiguity", summary: "The requirement has two interpretations." },
      { kind: "architecture_decision", summary: "A new boundary is required." },
      { kind: "scope_expansion", summary: "The repair needs another package." },
      { kind: "spec_conflict", summary: "The two specs disagree." },
    ] }, independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1" },
    { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1" },
  ]);

  assert.equal(result.repairable.length, 0);
  assert.deepEqual(result.blockers.map(({ kind }) => kind), [
    "requirement_ambiguity",
    "architecture_decision",
    "scope_expansion",
    "spec_conflict",
  ]);
  assert.equal(planRepairRound({ reviews: [{ role: "spec", state: "failed", report: { findings: [{ kind: "requirement_ambiguity", summary: "Ambiguous." }] }, independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1" }, { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1" }] }).action, "block");
});

test("an in-scope spec mismatch needs explicit scope evidence", () => {
  const reviews = [
    { role: "standards", state: "failed", report: { findings: [{ kind: "in_scope_spec_mismatch", summary: "Mismatch without scope proof." }] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1" },
    { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1" },
  ];
  assert.equal(classifyReviewFindings(reviews).blockers[0].kind, "in_scope_required");

  const explicitlyInScope = classifyReviewFindings([{
    ...reviews[0],
    report: { findings: [{ kind: "in_scope_spec_mismatch", in_scope: true, summary: "Mismatch within the approved plan." }] },
  }, reviews[1]]);
  assert.equal(explicitlyInScope.repairable.length, 1);
});

test("initial reviewer provenance is required before a repair decision can pass", async () => {
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [{ role: "spec", state: "passed" }],
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "review_input_invalid");
});

test("reviewer contexts must be distinct and malformed repair review results are preserved safely", async () => {
  const duplicateContexts = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "same", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "same", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
  });
  assert.equal(duplicateContexts.reason, "reviewer_isolation_violation");

  const malformed = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", summary: "Fix it." }] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
    dispatchRepair: async () => ({ plan_id: "plan-a", commit_sha: "impl-2", diff: "diff --git a/src/a b/src/a", commit_list: ["base-1", "impl-1", "impl-2"], fresh_context: true, empty_context: true, context_id: "repair-context" }),
    runReviewers: async () => undefined,
  });
  assert.equal(malformed.reason, "reviewer_isolation_violation");
  assert.deepEqual(malformed.reviews, []);
});

test("bounded repair dispatches one fresh repair and fresh reviewer round", async () => {
  const calls = [];
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", id: "impl-1", summary: "Fix it." }] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
    maxRounds: 1,
    dispatchRepair: async (input) => {
      calls.push({ type: "repair", input });
      return { plan_id: "plan-a", commit_sha: "impl-2", diff: "diff --git a/src/a b/src/a", commit_list: ["base-1", "impl-1", "impl-2"], fresh_context: true, empty_context: true, context_id: "repair-context" };
    },
    runReviewers: async (input) => {
      calls.push({ type: "review", input });
      return [
        { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-2", implementation_commit_sha: "impl-2", review_input: { ...REVIEW_INPUT, implementation_commit_sha: "impl-2", commit_list: ["base-1", "impl-1", "impl-2"], diff_range: { from: "base-1", to: "impl-2" } } },
        { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-2", implementation_commit_sha: "impl-2", review_input: { ...REVIEW_INPUT, implementation_commit_sha: "impl-2", commit_list: ["base-1", "impl-1", "impl-2"], diff_range: { from: "base-1", to: "impl-2" } } },
      ];
    },
  });

  assert.equal(result.state, "passed");
  assert.equal(result.rounds, 1);
  assert.equal(result.implementation.commit_sha, "impl-2");
  assert.deepEqual(calls.map(({ type }) => type), ["repair", "review"]);
  assert.equal(calls[0].input.fresh_context, true);
  assert.equal(calls[0].input.empty_context, true);
  assert.equal(calls[1].input.fresh_context, true);
  assert.equal(calls[1].input.empty_context, true);
  assert.equal(calls[1].input.review_input.diff_range.to, "impl-2");
  assert.deepEqual(calls[1].input.review_input.commit_list, ["base-1", "impl-1", "impl-2"]);
});

test("post-repair reviewers must validate the exact repaired review scope", async () => {
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", summary: "Fix it." }] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
    dispatchRepair: async () => ({ plan_id: "plan-a", commit_sha: "impl-2", diff: "diff --git a/src/a b/src/a", commit_list: ["base-1", "impl-1", "impl-2"], fresh_context: true, empty_context: true }),
    runReviewers: async () => [
      { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-2", implementation_commit_sha: "impl-2", review_input: { ...REVIEW_INPUT, implementation_commit_sha: "impl-2", commit_list: ["base-1", "impl-1", "impl-2"], diff_range: { from: "base-1", to: "impl-2" }, diff: "unrelated-diff" } },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-2", implementation_commit_sha: "impl-2", review_input: { ...REVIEW_INPUT, implementation_commit_sha: "impl-2", commit_list: ["base-1", "impl-1", "impl-2"], diff_range: { from: "base-1", to: "impl-2" } } },
    ],
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "reviewer_isolation_violation");
});

test("bounded repair stops after max rounds and never repairs a blocker", async () => {
  let dispatches = 0;
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", summary: "Fix it." }] }, independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
    maxRounds: 0,
    dispatchRepair: async () => { dispatches += 1; return null; },
    runReviewers: async () => [],
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "max_repair_rounds_exceeded");
  assert.equal(dispatches, 0);

  const blocker = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [
      { role: "spec", state: "failed", report: { findings: [{ kind: "scope_expansion", summary: "Out of scope." }] }, independent: true, fresh_context: true, context_id: "spec-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
      { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-1", implementation_commit_sha: "impl-1", review_input: REVIEW_INPUT },
    ],
    reviewInput: REVIEW_INPUT,
    dispatchRepair: async () => { dispatches += 1; return null; },
    runReviewers: async () => [],
  });
  assert.equal(blocker.state, "blocked");
  assert.equal(blocker.reason, "scope_expansion");
  assert.equal(dispatches, 0);
});


test('design changes return to Spec planning before consuming implementation repair', async () => {
  const reviews = ['standards', 'spec'].map((role) => ({ role, state: role === 'spec' ? 'failed' : 'passed', independent: true, fresh_context: true, context_id: role, implementation_commit_sha: 'impl-1', review_input: REVIEW_INPUT, report: { findings: role === 'spec' ? [{ kind: 'architecture_decision', summary: 'New command and reservation lifecycle require an approved design' }] : [] } }));
  let reserved = 0, dispatched = 0;
  const result = await runBoundedReviewRepair({ initialImplementation: { commit_sha: 'impl-1' }, initialReviews: reviews, reviewInput: REVIEW_INPUT, plan: { id: 'plan-a' }, reserveRepair: async () => { reserved++; }, dispatchRepair: async () => { dispatched++; } });
  assert.equal(result.state, 'blocked');
  assert.equal(result.next_action, 'spec-me');
  assert.match(result.resume_condition, /Approve the changed Specs/);
  assert.equal(result.rounds, 0);
  assert.equal(reserved, 0);
  assert.equal(dispatched, 0);
});
