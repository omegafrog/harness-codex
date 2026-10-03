import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeSystemTargets } from "../src/decision/artifacts.mjs";
import { evaluateStageGates, SYSTEM_TARGET_GATE_ID } from "../src/workflow/stage-gates.mjs";
import { loadNamedWorkflow, loadWorkflowText } from "../src/workflow/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("spec-me registers a System Target stage whose declared gate invokes the evaluator", async () => {
  const workflow = await loadNamedWorkflow("spec-me", { root: ROOT });
  const stage = workflow.stages.find((entry) => entry.id === "define-system-targets");

  assert.ok(stage);
  assert.ok(stage.gates.includes(SYSTEM_TARGET_GATE_ID));
  const result = await evaluateStageGates({ workflow, stageId: stage.id, root: ROOT, ticketId: "missing-system-target-fixture" });
  assert.equal(result.length, 1);
  assert.equal(result[0].rule_id, SYSTEM_TARGET_GATE_ID);
  assert.equal(result[0].status, "blocked");
  assert.match(result[0].evidence_path, /docs\/specs\/missing-system-target-fixture\/system-targets\.yaml$/);
});

test("System Target stage gate returns pass for valid YAML and fail for malformed YAML", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-target-stage-gate-"));
  try {
    const workflow = await loadNamedWorkflow("spec-me", { root: ROOT });
    const stageId = "define-system-targets";
    const targets = {
      schema_version: 1,
      id: "system-targets",
      system_characteristics: {
        interaction: "CLI and agent interaction.",
        workload: "On-demand local evaluation.",
        state: "Project-local YAML artifacts.",
        consistency: "Atomic replacement for one file.",
        availability: "Existing Node.js runtime.",
        growth: "No service traffic target is defined.",
      },
      initial: [],
      expected_growth: [],
      architecture_boundary: [],
    };
    await writeSystemTargets({ root, ticketId: "506", targets });
    const passing = await evaluateStageGates({ workflow, stageId, root, ticketId: "506" });
    assert.equal(passing[0].status, "pass");

    await writeFile(join(root, "docs", "specs", "506", "system-targets.yaml"), "schema_version: 2\n", "utf8");
    const failing = await evaluateStageGates({ workflow, stageId, root, ticketId: "506" });
    assert.equal(failing[0].status, "fail");
    assert.equal(failing[0].rule_id, SYSTEM_TARGET_GATE_ID);
    assert.equal(failing[0].violations[0].code, "invalid_schema_version");

    const emptyBoundaryCondition = structuredClone(targets);
    emptyBoundaryCondition.architecture_boundary.push({
      id: "empty-boundary-condition",
      metric: "rto",
      status: "resolved",
      condition: "",
      provenance: "business_requirement",
      confidence: "medium",
      rationale: "Fixture for a blank condition rejection.",
    });
    await writeFile(join(root, "docs", "specs", "506", "system-targets.yaml"), `${JSON.stringify(emptyBoundaryCondition, null, 2)}\n`, "utf8");
    const conditionFailure = await evaluateStageGates({ workflow, stageId, root, ticketId: "506" });
    assert.equal(conditionFailure[0].status, "fail");
    assert.equal(conditionFailure[0].violations[0].code, "invalid_condition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow loader rejects unregistered decision gates", () => {
  const raw = `
schema_version: 1
id: test
roles: [writer]
skills: [test]
hooks:
  before_dispatch: []
  before_handoff: []
  before_complete: []
  after_merge: []
stages:
  - id: targets
    role: writer
    skill: test
    model_tier: low
    gates: [system_targets_complete]
`;
  assert.doesNotThrow(() => loadWorkflowText(raw));
  assert.throws(() => loadWorkflowText(raw.replace("system_targets_complete", "arbitrary_gate")), /Unknown stage gate/);
});

test("System Target gate contains invalid ticket IDs in its diagnostic path", async () => {
  const result = await evaluateStageGates({
    workflow: { stages: [{ id: "targets", gates: [SYSTEM_TARGET_GATE_ID] }] },
    stageId: "targets",
    root: ROOT,
    ticketId: "../../outside",
  });

  assert.equal(result[0].status, "fail");
  assert.equal(result[0].evidence_path, "docs/specs/<invalid-ticket-id>/system-targets.yaml");
});
