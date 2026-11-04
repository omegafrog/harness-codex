import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateProject } from "../.harness/src/installer/update.mjs";
import { protectLocalInstallArtifacts } from "../.harness/src/installer/local-exclude.mjs";
import { evaluateWorkflowStage } from "../.harness/src/workflow/stage-gates.mjs";

test("installed review gate rejects missing and stale reviews and accepts the current admitted review", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-current-spec-review-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const dir = join(root, "docs/specs/example");
    await mkdir(dir, { recursive: true });
    for (const name of ["request.md", "product-spec.md", "architecture-spec.md"]) await writeFile(join(dir, name), `# ${name}\n`);
    const runtime = `file://${join(root, ".harness/src/workflow")}`;
    const { snapshotSpecReview, requireCurrentSpecReview } = await import(`${runtime}/spec-review.mjs`);
    const { updateReviewAttempt } = await import(`${runtime}/review-attempts.mjs`);
    await assert.rejects(requireCurrentSpecReview({ root, ticketId: "example" }), /recorded passing Architecture review/);
    const inputs = await snapshotSpecReview({ root, ticketId: "example" });
    assert.deepEqual(Object.keys(inputs).sort(), ["docs/specs/example/architecture-spec.md", "docs/specs/example/product-spec.md"]);
    await assert.rejects(snapshotSpecReview({ root, ticketId: "example", input_paths: ["docs/specs/example/request.md"] }), /limited to Product and Architecture Specs/);
    const scope = "spec-example-architecture";
    const admitted = await updateReviewAttempt({ root, scope, action: "begin", inputs });
    const review = { axis: "architecture", ticket_id: "example", reviewer_id: "reviewer", author_ids: ["writer"], fork_turns: "none", verdict: "pass", inputs, findings: [] };
    await updateReviewAttempt({ root, scope, action: "record", attemptId: admitted.attempt_id, inputs, review });
    assert.equal((await requireCurrentSpecReview({ root, ticketId: "example" })).status, "pass");
    await writeFile(join(dir, "request.md"), "# Changed request\n");
    await writeFile(join(root, "CONTEXT.md"), "# Changed glossary\n");
    assert.equal((await requireCurrentSpecReview({ root, ticketId: "example" })).status, "pass");
    await writeFile(join(dir, "architecture-spec.md"), "# Changed\n");
    await assert.rejects(requireCurrentSpecReview({ root, ticketId: "example" }), /inputs changed/);
    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.match(status, /docs\/specs\/example\/architecture-spec\.md/);
    assert.doesNotMatch(status, /\.harness\/src/);
    assert.match(execFileSync("git", ["check-ignore", "-v", ".harness/src/workflow/spec-review.mjs"], { cwd: root, encoding: "utf8" }), /\.harness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const condition of ["product_diagram_required", "architecture_diagram_required"]) {
  const workflow = { stages: [{ id: "diagram", condition }] };

  test(`${condition} dispatches and skips from its boolean input`, () => {
    assert.equal(evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: true } }).action, "dispatch");
    assert.equal(evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: false } }).action, "skip");
  });

  test(`${condition} blocks missing or non-boolean input`, () => {
    assert.throws(() => evaluateWorkflowStage({ workflow, stageId: "diagram", input: {} }), new RegExp(`input\\.${condition} must be a boolean`));
    assert.throws(() => evaluateWorkflowStage({ workflow, stageId: "diagram", input: { [condition]: "yes" } }), new RegExp(`input\\.${condition} must be a boolean`));
  });
}

test("installed decision gate CLI validates applicable Product and Architecture diagrams", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-diagram-gate-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    for (const axis of ["product", "architecture"]) {
      const specName = axis === "product" ? "product-spec.md" : "architecture-spec.md";
      const directory = join(root, "docs/specs/example/diagrams", axis);
      await mkdir(directory, { recursive: true });
      await mkdir(join(root, "docs/specs/example"), { recursive: true });
      await writeFile(join(root, "docs/specs/example", specName), `![Diagram](diagrams/${axis}/sample.svg)\n`);
      await writeFile(join(directory, "sample.puml"), "@startuml\n@enduml\n");
      await writeFile(join(directory, "sample.svg"), "<svg></svg>\n");
      const gate = axis === "product" ? "product_diagram_completion" : "architecture_diagram_completion";
      const result = JSON.parse(execFileSync(process.execPath, [join(root, ".codex/scripts/harness-decision-gate.mjs"), gate, "--ticket", "example"], { cwd: root, encoding: "utf8" }));
      assert.equal(result.status, "pass");
      assert.equal(result.rule_id, gate);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed diagram gates block missing and inconsistent artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-diagram-gate-blocked-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const gateCli = join(root, ".codex/scripts/harness-decision-gate.mjs");
    const specRoot = join(root, "docs/specs/example");
    const directory = join(specRoot, "diagrams/product");
    await mkdir(directory, { recursive: true });
    await writeFile(join(specRoot, "product-spec.md"), "No diagram link.\n");

    const runGate = () => {
      try {
        execFileSync(process.execPath, [gateCli, "product_diagram_completion", "--ticket", "example"], { cwd: root, encoding: "utf8" });
        assert.fail("expected installed gate to block");
      } catch (error) {
        assert.equal(error.status, 2);
        return JSON.parse(error.stdout);
      }
    };

    const missing = runGate();
    assert.equal(missing.status, "blocked");
    assert.ok(missing.violations.some(({ code }) => code === "missing_diagram_source"));

    await writeFile(join(directory, "sample.puml"), "@startuml\n@enduml\n");
    await writeFile(join(directory, "sample.svg"), "<svg></svg>\n");
    const inconsistent = runGate();
    assert.equal(inconsistent.status, "blocked");
    assert.ok(inconsistent.violations.some(({ code }) => code === "missing_diagram_link"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Architecture review gate blocks Specs still marked as draft or pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-spec-status-gate-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const specRoot = join(root, "docs/specs/example");
    await mkdir(specRoot, { recursive: true });
    await writeFile(join(specRoot, "request.md"), "# Request\n");
    await writeFile(join(specRoot, "product-spec.md"), "**Status:** Draft for review\n");
    await writeFile(join(specRoot, "architecture-spec.md"), "**Status:** Architecture Spec independent review pending\n");
    const runtime = `file://${join(root, ".harness/src/workflow")}`;
    const { snapshotSpecReview } = await import(`${runtime}/spec-review.mjs`);
    const inputs = await snapshotSpecReview({ root, ticketId: "example" });
    const reviewPath = join(root, ".io/runtime/spec-review-result.json");
    await mkdir(join(root, ".io/runtime"), { recursive: true });
    await writeFile(reviewPath, JSON.stringify({ architecture: {
      axis: "architecture", ticket_id: "example", reviewer_id: "reviewer", author_ids: ["author"],
      fork_turns: "none", verdict: "pass", findings: [], inputs,
    } }));
    const check = () => {
      try {
        execFileSync(process.execPath, [join(root, ".codex/scripts/harness-spec-review.mjs"), "check", "--root", root, "--ticket", "example", "--axis", "architecture", "--reviews", "runtime/spec-review-result.json"], { cwd: root, encoding: "utf8" });
        return null;
      } catch (error) {
        assert.equal(error.status, 1);
        return JSON.parse(error.stdout);
      }
    };

    const draft = check();
    assert.equal(draft?.status, "blocked");
    assert.match(draft.reason, /not finalized/i);

    await writeFile(join(specRoot, "product-spec.md"), "**Status:** Approved\n");
    await writeFile(join(specRoot, "architecture-spec.md"), "**Status:** Approved\n");
    const approvedInputs = await snapshotSpecReview({ root, ticketId: "example" });
    const saved = JSON.parse(await readFile(reviewPath, "utf8"));
    saved.architecture.inputs = approvedInputs;
    await writeFile(reviewPath, JSON.stringify(saved));
    assert.equal(JSON.parse(execFileSync(process.execPath, [join(root, ".codex/scripts/harness-spec-review.mjs"), "check", "--root", root, "--ticket", "example", "--axis", "architecture", "--reviews", "runtime/spec-review-result.json"], { cwd: root, encoding: "utf8" })).status, "pass");

    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.match(status, /docs\/specs\/example\/product-spec\.md/);
    assert.doesNotMatch(status, /\.codex\/scripts\/harness-spec-review\.mjs|\.harness\/src/);
    assert.match(execFileSync("git", ["check-ignore", "-v", ".codex/scripts/harness-spec-review.mjs"], { cwd: root, encoding: "utf8" }), /\.codex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
