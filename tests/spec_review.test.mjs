import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { inspectSpecReviews, snapshotSpecReview } from "../src/workflow/spec-review.mjs";
import { evaluateStageGates } from "../src/workflow/stage-gates.mjs";
import { loadNamedWorkflow } from "../src/workflow/loader.mjs";
import { sessionDirectory } from "../src/workflow/session-output.mjs";
import { updateReviewAttempt, assertReviewAttempt } from "../src/workflow/review-attempts.mjs";

const REPOSITORY_ROOT = process.cwd();
const ticketId = "spec-review-fixture";
async function fixture() {
  const root = await mkdtemp(join(sessionDirectory(REPOSITORY_ROOT), "tmp-"));
  const spec = join(root, "docs/specs", ticketId);
  await mkdir(spec, { recursive: true });
  await writeFile(join(spec, "request.md"), "User request\n");
  await writeFile(join(spec, "product-spec.md"), "Product requirements\n");
  await writeFile(join(spec, "architecture-spec.md"), "Architecture decisions\n");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function record(root, reviewer_id = "reviewer-architecture", author_ids = ["writer"], ...input_paths) {
  return {
    axis: "architecture",
    ticket_id: ticketId,
    reviewer_id,
    author_ids,
    fork_turns: "none",
    verdict: "pass",
    findings: [],
    inputs: await snapshotSpecReview({ root, ticketId, input_paths }),
  };
}

test("Architecture review accepts a fresh reviewer with a current Product and Architecture snapshot", async () => {
  const { root, cleanup } = await fixture();
  try {
    const architectureSnapshot = await snapshotSpecReview({ root, ticketId });
    assert.deepEqual(Object.keys(architectureSnapshot).filter((path) => path.endsWith("-spec.md")).sort(), ["docs/specs/spec-review-fixture/architecture-spec.md", "docs/specs/spec-review-fixture/product-spec.md"]);
    assert.ok(!Object.keys(architectureSnapshot).some((path) => path.includes("/diagrams/")));
    const reviews = { architecture: await record(root) };
    await mkdir(join(root, "docs/specs", ticketId, "diagrams/product"), { recursive: true });
    await writeFile(join(root, "docs/specs", ticketId, "diagrams/product/product.puml"), "diagram generated after review\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "pass");
  } finally { await cleanup(); }
});

test("Architecture review rejects missing, self, inherited, and unresolved material findings", async () => {
  const { root, cleanup } = await fixture();
  try {
    const good = { architecture: await record(root) };
    for (const reviews of [
      {},
      { architecture: { ...good.architecture, reviewer_id: "writer" } },
      { architecture: { ...good.architecture, fork_turns: "all" } },
      { architecture: { ...good.architecture, findings: [{ severity: "major", description: "Missing rule", evidence: "architecture-spec.md:1" }] } },
    ]) assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
  } finally { await cleanup(); }
});

test("Spec review snapshots invalidate on Spec, Product, and extra source changes", async () => {
  const { root, cleanup } = await fixture();
  try {
    const extra = join("docs/specs", ticketId, "source.md");
    await writeFile(join(root, extra), "source evidence\n");
    const reviews = { architecture: await record(root, "reviewer-architecture", ["writer"], extra) };
    await writeFile(join(root, "docs/specs", ticketId, "product-spec.md"), "Changed product requirements\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
    reviews.architecture = await record(root, "reviewer-architecture", ["writer"], extra);
    await writeFile(join(root, "docs/specs", ticketId, "architecture-spec.md"), "Changed architecture decisions\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
    reviews.architecture = await record(root, "reviewer-architecture", ["writer"], extra);
    await writeFile(join(root, extra), "changed source evidence\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
  } finally { await cleanup(); }
});

test("spec-me has only an Architecture review gate before applicable diagrams", async () => {
  const workflow = await loadNamedWorkflow("spec-me", { root: REPOSITORY_ROOT });
  assert.equal(workflow.stages.find((stage) => stage.id === "product-review"), undefined);
  const architectureReview = workflow.stages.find((stage) => stage.id === "architecture-review");
  for (const stage of ["define-system-targets", "domain-baseline"]) assert.ok(workflow.stages.find((candidate) => candidate.id === stage).needs.includes("product"));
  assert.ok(!architectureReview.needs.includes("architecture_diagram"));
  assert.ok(architectureReview.needs.includes("verify-architecture-decisions"));
  for (const diagram of ["product_diagram", "architecture_diagram"]) {
    assert.ok(workflow.stages.find((stage) => stage.id === diagram).needs.includes("architecture-review"));
  }

  const { root, cleanup } = await fixture();
  try {
    const architectureOnly = { architecture: await record(root) };
    assert.equal((await evaluateStageGates({ workflow, stageId: "architecture-review", root, ticketId, specReviews: architectureOnly }))[0].status, "pass");
    assert.equal((await evaluateStageGates({ workflow, stageId: "architecture-review", root, ticketId, specReviews: {} }))[0].status, "blocked");
    for (const [axis, stageId] of [["product", "product_diagram"], ["architecture", "architecture_diagram"]]) {
      const specName = axis === "product" ? "product-spec.md" : "architecture-spec.md";
      const relativeDir = `docs/specs/${ticketId}/diagrams/${axis}`;
      await mkdir(join(root, relativeDir), { recursive: true });
      await writeFile(join(root, `${relativeDir}/diagram.puml`), "@startuml\n@enduml\n");
      await writeFile(join(root, `${relativeDir}/diagram.svg`), "<svg></svg>\n");
      await writeFile(join(root, `docs/specs/${ticketId}/${specName}`), `Spec link: (diagrams/${axis}/diagram.svg)\n`);
      assert.equal((await evaluateStageGates({ workflow, stageId, root, ticketId }))[0].status, "pass");
      await writeFile(join(root, `${relativeDir}/diagram.svg`), "not svg\n");
      assert.equal((await evaluateStageGates({ workflow, stageId, root, ticketId }))[0].status, "blocked");
    }
    for (const [axis, stageId] of [["product", "product_diagram"], ["architecture", "architecture_diagram"]]) {
      const specName = axis === "product" ? "product-spec.md" : "architecture-spec.md";
      const relativeDir = `docs/specs/${ticketId}/diagrams/${axis}`;
      await mkdir(join(root, relativeDir), { recursive: true });
      await writeFile(join(root, `${relativeDir}/diagram.puml`), "@startuml\n@enduml\n");
      await writeFile(join(root, `${relativeDir}/diagram.svg`), "<svg></svg>\n");
      await writeFile(join(root, `docs/specs/${ticketId}/${specName}`), `Spec link: (diagrams/${axis}/diagram.svg)\n`);
      assert.equal((await evaluateStageGates({ workflow, stageId, root, ticketId }))[0].status, "pass");
      await writeFile(join(root, `${relativeDir}/diagram.svg`), "not svg\n");
      assert.equal((await evaluateStageGates({ workflow, stageId, root, ticketId }))[0].status, "blocked");
    }
  } finally { await cleanup(); }
});

test("review admission serializes dispatch, requires changes and bounds fresh reviewer retries", async () => {
  const { root, cleanup } = await fixture();
  const scope = `spec-${ticketId}-architecture`;
  const options = { root, scope };
  try {
    const inputs = await snapshotSpecReview({ root, ticketId });
    const starts = await Promise.allSettled([1, 2].map(() => updateReviewAttempt({ ...options, action: 'begin', inputs })));
    assert.equal(starts.filter((item) => item.status === 'fulfilled').length, 1);
    let attempt = starts.find((item) => item.status === 'fulfilled').value;
    await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs }), /already active/);
    for (let round = 1; round <= 3; round++) {
      const review = await record(root, `independent-${round}`);
      review.verdict = 'revise';
      review.findings = [{ severity: 'major', description: 'Missing failure case', evidence: 'architecture-spec.md:1' }];
      const result = await updateReviewAttempt({ ...options, action: 'record', attemptId: attempt.attempt_id, review, inputs: review.inputs });
      assert.equal(result.status, 'blocked');
      assert.equal(result.round, round);
      await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs: review.inputs }), /unchanged/);
      await writeFile(join(root, `docs/specs/${ticketId}/architecture-spec.md`), `Architecture revision ${round}\n`);
      const nextInputs = await snapshotSpecReview({ root, ticketId });
      if (round < 3) {
        attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs: nextInputs });
        assert.deepEqual(attempt.previous_findings, review.findings);
      } else await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs: nextInputs }), /budget exhausted/);
    }
    await assert.rejects(updateReviewAttempt({ ...options, action: 'resolve', reason: '' }), /Explicit user/);
    await updateReviewAttempt({ ...options, action: 'resolve', reason: 'User narrowed the failure scope; request.md:12' });
    const resumed = await updateReviewAttempt({ ...options, action: 'begin', inputs: await snapshotSpecReview({ root, ticketId }) });
    assert.equal(resumed.round, 1);
    const passing = await record(root, 'independent-resumed');
    await updateReviewAttempt({ ...options, action: 'record', attemptId: resumed.attempt_id, review: passing, inputs: passing.inputs });
    await assertReviewAttempt({ ...options, review: passing });
  } finally { await cleanup(); }
});

test("review results preserve stale inputs and require recorded completion before gates advance", async () => {
  const { root, cleanup } = await fixture();
  const options = { root, scope: `spec-${ticketId}-architecture` };
  try {
    const review = await record(root);
    const attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs: review.inputs });
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews: { architecture: review } })).status, 'blocked');
    await assert.rejects(updateReviewAttempt({ ...options, action: 'record', attemptId: 'wrong', review, inputs: review.inputs }), /No active review/);
    await writeFile(join(root, `docs/specs/${ticketId}/architecture-spec.md`), 'Changed during review\n');
    const changed = await snapshotSpecReview({ root, ticketId });
    const result = await updateReviewAttempt({ ...options, action: 'record', attemptId: attempt.attempt_id, review, inputs: changed });
    assert.equal(result.reason, 'stale');
    const next = await updateReviewAttempt({ ...options, action: 'begin', inputs: changed });
    const refreshed = await record(root);
    await assert.rejects(updateReviewAttempt({ ...options, action: 'record', attemptId: next.attempt_id, review: refreshed, inputs: changed }), /new reviewer/);
    refreshed.reviewer_id = 'second-independent-reviewer';
    assert.equal((await updateReviewAttempt({ ...options, action: 'record', attemptId: next.attempt_id, review: refreshed, inputs: changed })).status, 'pass');
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews: { architecture: refreshed } })).status, 'pass');
  } finally { await cleanup(); }
});

test("aborted reviewers release the slot and consume the same retry budget", async () => {
  const { root, cleanup } = await fixture();
  const options = { root, scope: `spec-${ticketId}-architecture` };
  try {
    const inputs = await snapshotSpecReview({ root, ticketId });
    for (let round = 1; round <= 3; round++) {
      const attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs });
      assert.equal(attempt.round, round);
      await assert.rejects(updateReviewAttempt({ ...options, action: 'abort', attemptId: attempt.attempt_id, reason: '' }), /Abort reason/);
      await updateReviewAttempt({ ...options, action: 'abort', attemptId: attempt.attempt_id, reason: 'Reviewer process terminated' });
    }
    await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs }), /budget exhausted/);
  } finally { await cleanup(); }
});
