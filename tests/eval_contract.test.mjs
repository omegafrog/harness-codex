import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHarnessConfig, loadSuite } from "../src/eval/case-loader.mjs";
import { detectTrajectoryViolation } from "../src/eval/graders/hard-gates.mjs";
import { QualityGrader } from "../src/eval/graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter } from "../src/eval/journal.mjs";
import { ExternalSystemPort } from "../src/eval/recording.mjs";
import { runSuite } from "../src/eval/runner.mjs";

const root = join(import.meta.dirname, "..");

test("loads versioned suite and registry-backed case contracts", async () => {
  const config = await loadHarnessConfig(root);
  const suite = await loadSuite(root, "p0", config);
  assert.equal(suite.cases.length, 4);
  assert.deepEqual(suite.cases[0].required_outcome, ["spec_complete", "ambiguity_resolved"]);
  assert.equal(suite.baseline.environment_profile, "p0-default");
});

test("event and trajectory writers serialize contiguous redacted records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-journal-"));
  try {
    const eventPath = join(dir, "events.jsonl");
    const eventWriter = await new JsonlEventWriter(eventPath, { streamId: "case-1" }).init();
    await Promise.all([eventWriter.append("one", { token: "secret" }), eventWriter.append("two", { ok: true }, { critical: true })]);
    await eventWriter.close();
    const events = (await readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
    assert.equal(events[0].payload.token, "[REDACTED]");

    const trajectoryPath = join(dir, "trajectory.jsonl");
    const trajectory = await new TrajectoryWriter(trajectoryPath, { streamId: "trajectory-1" }).init();
    const call = await trajectory.append({ kind: "tool_call", correlation_id: "call-42", action: "read_file", target: "README.md", payload: { authorization: "Bearer secret" } });
    await trajectory.close();
    assert.equal(call.correlation_id, "call-42");
    assert.equal(call.payload.authorization, "[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external port denies mutation and replay mismatch without live fallback", async () => {
  const events = [];
  const port = await new ExternalSystemPort({ mode: "none", onEvent: async (event) => events.push(event) }).init();
  await assert.rejects(() => port.execute({ system: "github", operation: "update_issue", target: { issue: 1 }, payload: { status: "Done" } }), (error) => error.reason === "unauthorized_external_mutation");
  assert.equal(events[0].type, "unauthorized_external_mutation");

  const dir = await mkdtemp(join(tmpdir(), "harness-eval-recording-"));
  try {
    const fixture = join(dir, "recording.jsonl");
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, response: { ok: true } })}\n`);
    const replay = await new ExternalSystemPort({ mode: "replay", fixture }).init();
    assert.deepEqual(await replay.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }), { ok: true });
    await assert.rejects(() => replay.execute({ system: "github", operation: "read_issue", target: { issue: 2 }, payload: {} }), (error) => error.reason === "missing_external_recording");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quality is independent from efficiency and uses the fixed formula", () => {
  const grader = new QualityGrader();
  const result = grader.grade({
    caseSpec: { id: "case", workflow: "spec-me", required_outcome: ["spec_complete"] },
    artifactBundle: {
      case_spec: { id: "case" },
      normalized_trajectory: [{ kind: "tool_call", action: "write_file", payload: {} }],
      normalized_events: [],
      final_output: "[OUTCOME:spec_complete]",
      outcome_evidence: { passed: true, missing: [], results: { spec_complete: true } },
      relevant_diff: null,
    },
  });
  assert.equal(result.quality, Number((0.65 * result.task_quality + 0.35 * result.trajectory_quality).toFixed(4)));
  assert.equal(result.efficiency, undefined);
  assert.equal(detectTrajectoryViolation({ action: "read_file", target: "src/Foo.java" }, { forbidden_actions: [{ gate: "product_source_read_forbidden", action: "read_file", target_prefix: "src/" }] }, "/tmp/case" ).gate, "product_source_read_forbidden");
});

test("runner produces a passing isolated P0 suite with an explicit command override", async () => {
  const emitter = join(root, "evals/fixtures/emit-eval.mjs");
  const result = await runSuite({ root, suiteId: "p0", runId: `test-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, emitter] });
  try {
    assert.equal(result.passed, true);
    assert.equal(result.counts.inconclusive, 0);
    assert.equal(result.baseline.environment_profile, "p0-default");
  } finally {
    await rm(result.run_dir, { recursive: true, force: true });
  }
});
