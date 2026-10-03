import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readSystemTargets, writeSystemTargets } from "../src/decision/artifacts.mjs";
import { createSystemTargets, SYSTEM_TARGET_METRICS } from "../src/decision/model.mjs";
import { validateSystemTargets } from "../src/decision/validation.mjs";
import { parseYaml } from "../src/eval/yaml.mjs";

const VALID_TARGETS = {
  schema_version: 1,
  id: "system-targets",
  system_characteristics: {
    interaction: "Users submit requests and poll job status.",
    workload: "Bursty daytime traffic.",
    state: "Jobs and results are retained.",
    consistency: "A submitted job must not be duplicated.",
    availability: "Users need to submit and inspect jobs.",
    growth: "Workload is expected to grow.",
  },
  initial: [
    { id: "initial-average-rps", metric: "average_rps", value: 8, unit: "requests/second", provenance: "measured", confidence: "high", rationale: "Recent production sample." },
  ],
  expected_growth: [],
  architecture_boundary: [
    { id: "worker-backlog-boundary", metric: "job_backlog", condition: "Alert when the oldest queued job is over 5 minutes old.", provenance: "business_requirement", confidence: "medium", rationale: "Operations requires timely job completion." },
    { id: "unknown-peak-rps", metric: "peak_rps", status: "unresolved", provenance: "assumption", confidence: "low", rationale: "Peak traffic has not been measured; collect a representative sample." },
  ],
};

test("System Target model starts with optional metric groups and names supported NFRs", () => {
  const targets = createSystemTargets(VALID_TARGETS.system_characteristics);

  assert.deepEqual(targets.initial, []);
  assert.deepEqual(targets.expected_growth, []);
  assert.deepEqual(targets.architecture_boundary, []);
  assert.ok(SYSTEM_TARGET_METRICS.includes("peak_rps"));
  assert.ok(SYSTEM_TARGET_METRICS.includes("latency_p99_ms"));
});

test("System Target schema is valid YAML and closes the provenance contract", async () => {
  const schemaPath = fileURLToPath(new URL("../.codex/schemas/decision/system-targets.schema.yaml", import.meta.url));
  const schema = parseYaml(await readFile(schemaPath, "utf8"));

  assert.equal(schema.id, "system-targets");
  assert.equal(schema.additional_properties, false);
  assert.deepEqual(schema.properties.system_characteristics.required, ["interaction", "workload", "state", "consistency", "availability", "growth"]);
  assert.equal(schema.properties.initial.items.oneOf.length, 2);
  assert.deepEqual(schema.properties.initial.items.oneOf[0].allOf[1].required, ["value", "unit"]);
  assert.deepEqual(schema.properties.initial.items.oneOf[1].allOf[1].required, ["status"]);
  assert.equal(schema.properties.architecture_boundary.items.oneOf.length, 3);
  assert.deepEqual(schema.properties.architecture_boundary.items.oneOf[1].allOf[1].required, ["condition"]);
});

test("system targets accept related-only metrics, condition boundaries, and explicit unresolved values", () => {
  const result = validateSystemTargets(VALID_TARGETS);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("system target validation rejects missing characteristics and fabricated unresolved values", () => {
  const missingCharacteristics = structuredClone(VALID_TARGETS);
  delete missingCharacteristics.system_characteristics.growth;
  assert.equal(validateSystemTargets(missingCharacteristics).valid, false);

  const fabricated = structuredClone(VALID_TARGETS);
  fabricated.architecture_boundary[1].value = 9000;
  fabricated.architecture_boundary[1].unit = "requests/second";
  const result = validateSystemTargets(fabricated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "unresolved_target_has_value"));

  const nullStatus = structuredClone(VALID_TARGETS);
  nullStatus.initial[0].status = null;
  assert.ok(validateSystemTargets(nullStatus).errors.some((error) => error.code === "invalid_target_status"));
});

test("system target validation checks allowed provenance, finite values, and stable unique IDs", () => {
  const invalid = structuredClone(VALID_TARGETS);
  invalid.initial[0].provenance = "guess";
  invalid.expected_growth.push({ ...invalid.initial[0], id: invalid.initial[0].id, value: Number.NaN });
  invalid.architecture_boundary[0].value = -5;

  const result = validateSystemTargets(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "invalid_provenance"));
  assert.ok(result.errors.some((error) => error.code === "duplicate_target_id"));
  assert.ok(result.errors.some((error) => error.code === "invalid_value"));
});

test("system target artifact adapter atomically writes and reads the ticket YAML", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-target-artifacts-"));
  try {
    const written = await writeSystemTargets({ root, ticketId: "506", targets: VALID_TARGETS });
    assert.equal(written.path, join(root, "docs", "specs", "506", "system-targets.yaml"));
    assert.deepEqual(await readSystemTargets({ root, ticketId: "506" }), VALID_TARGETS);
    assert.match(await readFile(written.path, "utf8"), /schema_version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system target artifact adapter rejects unsafe ticket paths and invalid content", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-target-artifacts-"));
  try {
    await assert.rejects(() => writeSystemTargets({ root, ticketId: "../outside", targets: VALID_TARGETS }), /safe ticket identifier/);
    await assert.rejects(() => writeSystemTargets({ root, ticketId: "506", targets: { ...VALID_TARGETS, schema_version: 2 } }), /schema_version/);
    await assert.rejects(() => writeSystemTargets({ root, ticketId: "506", targets: VALID_TARGETS, path: "../../outside.yaml" }), /not configurable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system target artifact adapter rejects a symlinked ticket directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-target-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "system-target-outside-"));
  try {
    await mkdir(join(root, "docs", "specs"), { recursive: true });
    await symlink(outside, join(root, "docs", "specs", "506"));
    await assert.rejects(() => writeSystemTargets({ root, ticketId: "506", targets: VALID_TARGETS }), /cannot pass through a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
