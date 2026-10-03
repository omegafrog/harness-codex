import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeSystemTargets } from "../src/decision/artifacts.mjs";

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
