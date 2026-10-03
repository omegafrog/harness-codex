import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readSystemTargets, writeSystemTargets } from "../src/decision/artifacts.mjs";
import { loadNamedWorkflow } from "../src/workflow/index.mjs";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPOSITORY_ROOT, ".codex", "scripts", "harness-decision-gate.mjs");

const TARGETS = {
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

test("decision gate CLI validates stored System Targets and returns the gate verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-gate-cli-"));
  try {
    await writeSystemTargets({ root, ticketId: "506", targets: TARGETS });
    const result = spawnSync(process.execPath, [SCRIPT, "system_targets_complete", "--ticket", "506"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision gate CLI reports missing targets as blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-gate-cli-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "system_targets_complete", "--ticket", "506"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec-me System Target workflow records only related NFRs and passes the CLI gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-gate-contract-"));
  try {
    const workflow = await loadNamedWorkflow("spec-me", { root: REPOSITORY_ROOT });
    const stage = workflow.stages.find((entry) => entry.id === "define-system-targets");
    assert.ok(stage);
    assert.ok(stage.gates.includes("system_targets_complete"));

    const authoring = await readFile(join(REPOSITORY_ROOT, ".codex", "skills", "spec-me", "SKILL.md"), "utf8");
    assert.match(authoring, /ask only NFR questions related to those characteristics/i);
    assert.match(authoring, /unknown values as `status: unresolved`/i);

    const requested = {
      interaction: "A CLI and agent workflow that creates ticket-scoped specs.",
      workload: "Burst traffic is possible during batch evaluations.",
      state: "One YAML artifact per ticket.",
      consistency: "The artifact must be replaced atomically.",
      availability: "The existing Node.js process is available during CLI execution.",
      growth: "No service traffic growth is expected.",
    };
    const targets = {
      ...TARGETS,
      system_characteristics: requested,
      expected_growth: [{
        id: "peak-burst-rps",
        metric: "burst_rps",
        status: "unresolved",
        provenance: "assumption",
        confidence: "low",
        rationale: "The workload description identifies bursts but provides no numeric estimate.",
      }],
    };

    await writeSystemTargets({ root, ticketId: "506", targets });
    const stored = await readSystemTargets({ root, ticketId: "506" });
    assert.deepEqual(stored.system_characteristics, requested);
    assert.deepEqual(stored.initial, []);
    assert.deepEqual(stored.expected_growth, [targets.expected_growth[0]]);
    assert.deepEqual(stored.architecture_boundary, []);

    const result = spawnSync(process.execPath, [SCRIPT, "system_targets_complete", "--ticket", "506"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.status, "pass");
    assert.match(verdict.evidence_path, /docs\/specs\/506\/system-targets\.yaml$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
