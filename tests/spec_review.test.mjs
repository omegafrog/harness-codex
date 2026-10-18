import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { inspectSpecReviews, snapshotSpecReview } from "../src/workflow/spec-review.mjs";
import { evaluateStageGates } from "../src/workflow/stage-gates.mjs";
import { loadNamedWorkflow } from "../src/workflow/loader.mjs";
import { sessionDirectory } from "../src/workflow/session-output.mjs";

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
