import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateProject } from "../.harness/src/installer/update.mjs";
import { evaluateWorkflowStage } from "../.harness/src/workflow/stage-gates.mjs";

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
