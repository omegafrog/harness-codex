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
  await mkdir(join(spec, "diagrams/product"), { recursive: true });
  await mkdir(join(spec, "diagrams/architecture"), { recursive: true });
  await writeFile(join(spec, "request.md"), "User request\n");
  await writeFile(join(spec, "product-spec.md"), "Product requirements\n");
  await writeFile(join(spec, "architecture-spec.md"), "Architecture decisions\n");
  await writeFile(join(spec, "diagrams/product/product.puml"), "@startuml\n@enduml\n");
  await writeFile(join(spec, "diagrams/architecture/architecture.puml"), "@startuml\n@enduml\n");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function record(root, axis, reviewer_id = `reviewer-${axis}`, author_ids = ["writer"], ...input_paths) {
  return {
    axis,
    ticket_id: ticketId,
    reviewer_id,
    author_ids,
    fork_turns: "none",
    verdict: "pass",
    findings: [],
    inputs: await snapshotSpecReview({ root, ticketId, axis, input_paths }),
  };
}

test("Spec review accepts distinct fresh reviewers with current snapshots", async () => {
  const { root, cleanup } = await fixture();
  try {
    const reviews = { product: await record(root, "product"), architecture: await record(root, "architecture") };
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "pass");
  } finally { await cleanup(); }
});

test("Spec review rejects missing, self, inherited, duplicate reviewer, and unresolved material findings", async () => {
  const { root, cleanup } = await fixture();
  try {
    const good = { product: await record(root, "product"), architecture: await record(root, "architecture") };
    for (const reviews of [
      { product: good.product },
      { product: { ...good.product, reviewer_id: "writer" }, architecture: good.architecture },
      { product: { ...good.product, fork_turns: "all" }, architecture: good.architecture },
      { product: good.product, architecture: { ...good.architecture, reviewer_id: good.product.reviewer_id } },
      { product: good.product, architecture: { ...good.architecture, author_ids: ["reviewer-product"] } },
      { product: { ...good.product, findings: [{ severity: "major", description: "Missing rule", evidence: "product-spec.md:1" }] }, architecture: good.architecture },
    ]) assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
  } finally { await cleanup(); }
});

test("Spec review snapshots invalidate on Spec, Product, and extra source changes", async () => {
  const { root, cleanup } = await fixture();
  try {
    const extra = join("docs/specs", ticketId, "source.md");
    await writeFile(join(root, extra), "source evidence\n");
    const reviews = {
      product: await record(root, "product"),
      architecture: await record(root, "architecture", "reviewer-architecture", ["writer"], extra),
    };
    await writeFile(join(root, "docs/specs", ticketId, "product-spec.md"), "Changed product requirements\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews, axes: ["architecture"] })).status, "blocked");
    reviews.architecture = await record(root, "architecture", "reviewer-architecture", ["writer"], extra);
    await writeFile(join(root, "docs/specs", ticketId, "architecture-spec.md"), "Changed architecture decisions\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews, axes: ["architecture"] })).status, "blocked");
    reviews.product = await record(root, "product");
    reviews.architecture = await record(root, "architecture", "reviewer-architecture", ["writer"], extra);
    await writeFile(join(root, extra), "changed source evidence\n");
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews })).status, "blocked");
  } finally { await cleanup(); }
});

test("stage gates route product and architecture reviews; spec-me orders reviews before advancement", async () => {
  const workflow = await loadNamedWorkflow("spec-me", { root: REPOSITORY_ROOT });
  const productReview = workflow.stages.find((stage) => stage.id === "product-review");
  const architectureReview = workflow.stages.find((stage) => stage.id === "architecture-review");
  assert.ok(productReview.needs.includes("product_diagram"));
  assert.ok(workflow.stages.find((stage) => stage.id === "define-system-targets").needs.includes("product-review"));
  assert.ok(architectureReview.needs.includes("architecture_diagram"));
  assert.ok(architectureReview.needs.includes("verify-architecture-decisions"));
  for (const stage of ["define-system-targets", "domain-baseline"]) assert.ok(workflow.stages.find((candidate) => candidate.id === stage).needs.includes("product-review"));

  const { root, cleanup } = await fixture();
  try {
    const productOnly = { product: await record(root, "product"), architecture: await record(root, "architecture") };
    assert.equal((await evaluateStageGates({ workflow, stageId: "product-review", root, ticketId, specReviews: productOnly }))[0].status, "pass");
    assert.equal((await evaluateStageGates({ workflow, stageId: "architecture-review", root, ticketId, specReviews: productOnly }))[0].status, "pass");
    assert.equal((await evaluateStageGates({ workflow, stageId: "product-review", root, ticketId, specReviews: {} }))[0].status, "blocked");
  } finally { await cleanup(); }
});

test("review admission serializes dispatch, requires changes and bounds fresh reviewer retries", async () => {
  const { root, cleanup } = await fixture();
  const scope = `spec-${ticketId}-product`;
  const options = { root, scope };
  try {
    const inputs = await snapshotSpecReview({ root, ticketId, axis: 'product' });
    const starts = await Promise.allSettled([1, 2].map(() => updateReviewAttempt({ ...options, action: 'begin', inputs })));
    assert.equal(starts.filter((item) => item.status === 'fulfilled').length, 1);
    let attempt = starts.find((item) => item.status === 'fulfilled').value;
    await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs }), /already active/);
    for (let round = 1; round <= 3; round++) {
      const review = await record(root, 'product', `independent-${round}`);
      review.verdict = 'revise';
      review.findings = [{ severity: 'major', description: 'Missing failure case', evidence: 'product-spec.md:1' }];
      const result = await updateReviewAttempt({ ...options, action: 'record', attemptId: attempt.attempt_id, review, inputs: review.inputs });
      assert.equal(result.status, 'blocked');
      assert.equal(result.round, round);
      await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs: review.inputs }), /unchanged/);
      await writeFile(join(root, `docs/specs/${ticketId}/product-spec.md`), `Product revision ${round}\n`);
      const nextInputs = await snapshotSpecReview({ root, ticketId, axis: 'product' });
      if (round < 3) {
        attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs: nextInputs });
        assert.deepEqual(attempt.previous_findings, review.findings);
      } else await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs: nextInputs }), /budget exhausted/);
    }
    await assert.rejects(updateReviewAttempt({ ...options, action: 'resolve', reason: '' }), /Explicit user/);
    await updateReviewAttempt({ ...options, action: 'resolve', reason: 'User narrowed the failure scope; request.md:12' });
    const resumed = await updateReviewAttempt({ ...options, action: 'begin', inputs: await snapshotSpecReview({ root, ticketId, axis: 'product' }) });
    assert.equal(resumed.round, 1);
    const passing = await record(root, 'product', 'independent-resumed');
    await updateReviewAttempt({ ...options, action: 'record', attemptId: resumed.attempt_id, review: passing, inputs: passing.inputs });
    await assertReviewAttempt({ ...options, review: passing });
  } finally { await cleanup(); }
});

test("review results preserve stale inputs and require recorded completion before gates advance", async () => {
  const { root, cleanup } = await fixture();
  const options = { root, scope: `spec-${ticketId}-product` };
  try {
    const review = await record(root, 'product');
    const attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs: review.inputs });
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews: { product: review }, axes: ['product'] })).status, 'blocked');
    await assert.rejects(updateReviewAttempt({ ...options, action: 'record', attemptId: 'wrong', review, inputs: review.inputs }), /No active review/);
    await writeFile(join(root, `docs/specs/${ticketId}/product-spec.md`), 'Changed during review\n');
    const changed = await snapshotSpecReview({ root, ticketId, axis: 'product' });
    const result = await updateReviewAttempt({ ...options, action: 'record', attemptId: attempt.attempt_id, review, inputs: changed });
    assert.equal(result.reason, 'stale');
    const next = await updateReviewAttempt({ ...options, action: 'begin', inputs: changed });
    const refreshed = await record(root, 'product');
    await assert.rejects(updateReviewAttempt({ ...options, action: 'record', attemptId: next.attempt_id, review: refreshed, inputs: changed }), /new reviewer/);
    refreshed.reviewer_id = 'second-independent-reviewer';
    assert.equal((await updateReviewAttempt({ ...options, action: 'record', attemptId: next.attempt_id, review: refreshed, inputs: changed })).status, 'pass');
    assert.equal((await inspectSpecReviews({ root, ticketId, reviews: { product: refreshed }, axes: ['product'] })).status, 'pass');
  } finally { await cleanup(); }
});

test("aborted reviewers release the slot and consume the same retry budget", async () => {
  const { root, cleanup } = await fixture();
  const options = { root, scope: `spec-${ticketId}-product` };
  try {
    const inputs = await snapshotSpecReview({ root, ticketId, axis: 'product' });
    for (let round = 1; round <= 3; round++) {
      const attempt = await updateReviewAttempt({ ...options, action: 'begin', inputs });
      assert.equal(attempt.round, round);
      await assert.rejects(updateReviewAttempt({ ...options, action: 'abort', attemptId: attempt.attempt_id, reason: '' }), /Abort reason/);
      await updateReviewAttempt({ ...options, action: 'abort', attemptId: attempt.attempt_id, reason: 'Reviewer process terminated' });
    }
    await assert.rejects(updateReviewAttempt({ ...options, action: 'begin', inputs }), /budget exhausted/);
  } finally { await cleanup(); }
});
