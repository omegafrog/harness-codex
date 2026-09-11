import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { loadCase, loadHarnessConfig, loadSuite, validateCaseManifest } from "../src/eval/case-loader.mjs";
import { CodexProcessAdapter, resolveCodexCommand } from "../src/eval/codex-adapter.mjs";
import { detectTrajectoryViolation } from "../src/eval/graders/hard-gates.mjs";
import { gradeOutcome } from "../src/eval/graders/outcome.mjs";
import { QualityGrader } from "../src/eval/graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter, projectCheckpoint, recoverEventStream, recoverTrajectoryStream, replayEventStream, replayTrajectoryStream } from "../src/eval/journal.mjs";
import { ExplicitIntegrationAdapter, ExternalPortSubprocess, ExternalSystemPort, GitHubRecordingAdapter, GitHubStub, MCPRecordingAdapter, MCPStub, RoutedExternalSystemPort, createExternalSystemPort, validateRecordingFixture } from "../src/eval/recording.mjs";
import { openPlanJournal, planRuntimePaths } from "../src/eval/plan-journal.mjs";
import { evaluateSuite, finalizeCase } from "../src/eval/report.mjs";
import { resolveCodexHome, runSuiteForTest, seedCodexAuth } from "../src/eval/runner.mjs";
import { assertWorkspaceTarget, cleanupCaseWorkspace, provisionCaseWorkspace } from "../src/eval/case-workspace.mjs";
import { ResourceGraph, WorktreeManager, runScheduledPlanGroup, schedulePlans } from "../src/eval/plan-workspace.mjs";
import { EvalPolicyViolationError } from "../src/eval/errors.mjs";

const root = join(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

function runProcess(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("loads versioned suite and registry-backed case contracts", async () => {
  const config = await loadHarnessConfig(root);
  const suite = await loadSuite(root, "p0", config);
  assert.equal(suite.cases.length, 4);
  assert.deepEqual(suite.cases[0].required_outcome, ["spec_complete", "ambiguity_resolved"]);
  assert.equal(suite.baseline.environment_profile, "p0-default");
  assert.equal(suite.baseline.metrics.tokens, 379707);
  assert.equal(suite.baseline.metrics.latency_ms, 224091);
});

test("suite compares efficiency against a versioned baseline", () => {
  const report = evaluateSuite({
    suite: {
      id: "baseline-test",
      baseline: { id: "baseline", metrics: { tokens: 100, latency_ms: 200 } },
      thresholds: {
        hard_gate_failures: 0,
        critical_case_pass_rate: 1,
        pass_rate: 1,
        mean_quality: 0,
        p10_quality: 0,
        overall: 0,
        max_token_regression: 0.2,
        max_latency_regression: 0.25,
        max_inconclusive_rate: 0,
        minimum_conclusive_cases: 1,
      },
    },
    caseResults: [{
      state: "passed",
      critical: true,
      hard_gates: { passed: true },
      quality: { quality: 1 },
      efficiency: { tokens: 110, latency_ms: 220 },
    }],
  });
  assert.equal(report.regressions.tokens.available, true);
  assert.equal(report.regressions.tokens.ratio, 0.1);
  assert.equal(report.regressions.latency_ms.available, true);
  assert.equal(report.regressions.latency_ms.ratio, 0.1);
  assert.equal(report.checks.token_regression, true);
  assert.equal(report.checks.latency_regression, true);
});

test("eval config and manifest roots cannot escape the repository", async () => {
  await assert.rejects(() => loadHarnessConfig(root, "/tmp/outside-harness.yaml"), /Config escapes repository root/);
  const dir = await mkdtemp(join(root, ".eval-config-boundary-"));
  try {
    const configPath = join(dir, "harness.yaml");
    await writeFile(configPath, "tracker:\n  mode: local\neval:\n  suite_paths: \"..\\\\outside\"\n");
    await assert.rejects(() => loadHarnessConfig(root, configPath), /eval.suite_paths escapes repository root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("case fixture traversal is rejected with portable path separators", async () => {
  const dir = await mkdtemp(join(root, ".eval-case-boundary-"));
  try {
    const casePath = join(dir, "portable-case.yaml");
    await writeFile(casePath, [
      "schema_version: 1",
      "id: portable-case",
      "workflow: spec-me",
      "required_outcome: [spec_complete]",
      "outcome_evidence:",
      "  spec_complete:",
      "    actions: [write_file]",
      "    required_files: [output.md]",
      "hard_gates: [product_source_read_forbidden]",
      "quality_threshold: 0.75",
      "hard_caps: {}",
      "integration: false",
      "recording: {mode: none}",
      "fixture: \"..\\\\outside\"",
    ].join("\n"), "utf8");
    await assert.rejects(
      () => loadCase(root, "portable-case", { eval: { case_paths: dir } }, casePath),
      /Fixture escapes repository root/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("case preflight rejects missing canonical workflows as inconclusive", async () => {
  const dir = await mkdtemp(join(root, ".eval-workflow-boundary-"));
  try {
    const casePath = join(dir, "missing-workflow-case.yaml");
    await writeFile(casePath, [
      "schema_version: 1",
      "id: missing-workflow-case",
      "workflow: missing-workflow",
      "required_outcome: [spec_complete]",
      "outcome_evidence:",
      "  spec_complete:",
      "    actions: [write_file]",
      "    required_files: [output.md]",
      "hard_gates: [workflow_order_violation]",
      "quality_threshold: 0.75",
      "hard_caps: {}",
      "integration: false",
      "recording: {mode: none}",
    ].join("\n"), "utf8");
    await assert.rejects(
      () => loadCase(root, "missing-workflow-case", { eval: { case_paths: dir } }, casePath),
      (error) => error.reason === "invalid_workflow_manifest" && error.details.workflow === "missing-workflow",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live integration cases require an explicitly dedicated resource", () => {
  const base = {
    schema_version: 1,
    id: "integration-case",
    workflow: "code-review",
    required_outcome: ["review_verdict_preserved"],
    outcome_evidence: { review_verdict_preserved: { actions: ["review_verdict"], required_files: ["review.json"] } },
    hard_gates: ["reviewer_write_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
    integration: true,
    recording: { mode: "live" },
  };
  assert.throws(() => validateCaseManifest(base), /integration_resource is required/);
  assert.throws(() => validateCaseManifest({ ...base, integration: false, recording: { mode: "none" }, integration_resource: { system: "github", resource_id: "fixture", target: { repo: "fixture/repo" }, dedicated: true } }), /requires integration: true/);
  assert.throws(() => validateCaseManifest({
    ...base,
    integration_resource: { system: "github", resource_id: "fixture", target: { repo: "fixture/repo" }, dedicated: false },
  }), /dedicated must be true/);
  const valid = validateCaseManifest({
    ...base,
    integration_resource: { system: "github", resource_id: "fixture", target: { repo: "fixture/repo" }, dedicated: true },
  });
  assert.equal(valid.integration_resource.resource_id, "fixture");
});

test("case preflight requires structured evidence for every outcome", () => {
  const base = {
    schema_version: 1,
    id: "evidence-case",
    workflow: "spec-me",
    required_outcome: ["spec_complete"],
    hard_gates: ["product_source_read_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
  };
  assert.throws(() => validateCaseManifest(base), /outcome_evidence must be an object/);
  assert.throws(() => validateCaseManifest({ ...base, outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["\.\./outside"] } } }), /repository-relative path/);
  assert.throws(() => validateCaseManifest({ ...base, outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["C:\\outside\\proof.txt"] } } }), /repository-relative path/);
  assert.throws(() => validateCaseManifest({ ...base, outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["\\\\server\\share\\proof.txt"] } } }), /repository-relative path/);
  const valid = validateCaseManifest({ ...base, outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["output.md"] } } });
  assert.deepEqual(valid.outcome_evidence.spec_complete.actions, ["write_file"]);
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
    const metrics = await new JsonlEventWriter(join(dir, "metrics.jsonl"), { streamId: "metrics-1" }).init();
    const metric = await metrics.append("usage", { tokens: 42, access_token: "secret" });
    await metrics.close();
    assert.equal(metric.payload.tokens, 42);
    assert.equal(metric.payload.access_token, "[REDACTED]");

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

test("journal quarantines malformed final lines and rejects sequence corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-recovery-"));
  try {
    const path = join(dir, "events.jsonl");
    const valid = { schema_version: 1, stream_id: "plan-1", seq: 1, timestamp: "2026-01-01T00:00:00.000Z", type: "started", payload: {} };
    await writeFile(path, `${JSON.stringify(valid)}\n{"schema_version":1,"stream_id":"plan-1"`);
    const replay = await replayEventStream(path, { streamId: "plan-1" });
    assert.equal(replay.corruption.kind, "malformed_final_line");
    assert.equal(replay.recovered, true);
    assert.equal(await readFile(replay.corruption.fragment, "utf8"), '{"schema_version":1,"stream_id":"plan-1"');
    const recovered = await recoverEventStream(path, { streamId: "plan-1" });
    assert.equal(recovered.events.at(-1).type, "journal_recovered");
    const repaired = await replayEventStream(path, { streamId: "plan-1" });
    assert.equal(repaired.valid, true);
    const checkpoint = join(dir, "checkpoint.md");
    await projectCheckpoint(recovered.events, checkpoint, { streamId: "plan-1", corruption: replay.corruption });
    const checkpointText = await readFile(checkpoint, "utf8");
    assert.match(checkpointText, /last_seq: 2/);
    assert.match(checkpointText, /recovery: malformed_final_line/);

    const appendPath = join(dir, "append-after-tail.jsonl");
    await writeFile(appendPath, `${JSON.stringify(valid)}\n{"schema_version":1,"stream_id":"plan-1"`);
    const appendWriter = await new JsonlEventWriter(appendPath, { streamId: "plan-1" }).init();
    await appendWriter.append("continued", {});
    await appendWriter.close();
    const appended = await replayEventStream(appendPath, { streamId: "plan-1" });
    assert.equal(appended.valid, true);
    assert.deepEqual(appended.events.map((event) => event.type), ["started", "journal_recovered", "continued"]);

    const gapPath = join(dir, "gap.jsonl");
    await writeFile(gapPath, `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, seq: 3 })}\n`);
    const gap = await replayEventStream(gapPath, { streamId: "plan-1" });
    assert.equal(gap.corruption.kind, "sequence_gap");
    assert.equal(await readFile(gap.corruption.fragment, "utf8"), JSON.stringify({ ...valid, seq: 3 }));
    const duplicatePath = join(dir, "duplicate.jsonl");
    await writeFile(duplicatePath, `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`);
    const duplicate = await replayEventStream(duplicatePath, { streamId: "plan-1" });
    assert.equal(duplicate.corruption.kind, "duplicate_sequence");
    assert.match(await readFile(duplicate.corruption.metadata, "utf8"), /duplicate_sequence/);
    const recoveredGap = await recoverEventStream(gapPath, { streamId: "plan-1", checkpointPath: join(dir, "gap-checkpoint.md") });
    assert.equal(recoveredGap.recovered, true);
    assert.equal(recoveredGap.events.at(-1).type, "journal_recovered");
    assert.match(await readFile(join(dir, "gap-checkpoint.md"), "utf8"), /recovery: sequence_gap/);

    const malformedMiddlePath = join(dir, "malformed-middle.jsonl");
    await writeFile(malformedMiddlePath, `${JSON.stringify(valid)}\nnot-json\n${JSON.stringify({ ...valid, seq: 2 })}\n`);
    const malformedMiddle = await replayEventStream(malformedMiddlePath, { streamId: "plan-1" });
    assert.equal(malformedMiddle.corruption.kind, "malformed_line");
    assert.ok(malformedMiddle.corruption.metadata);

    const trajectoryPath = join(dir, "trajectory-recovery.jsonl");
    const trajectoryRecord = { schema_version: 1, stream_id: "trajectory-1", seq: 1, timestamp: "2026-01-01T00:00:00.000Z", actor: "codex", kind: "message", payload: { text: "started" }, source: "structured_event" };
    await writeFile(trajectoryPath, `${JSON.stringify(trajectoryRecord)}\n{"schema_version":1,"stream_id":"trajectory-1"`);
    const trajectoryWriter = await new TrajectoryWriter(trajectoryPath, { streamId: "trajectory-1" }).init();
    await trajectoryWriter.append({ kind: "message", actor: "codex", payload: { text: "continued" } });
    await trajectoryWriter.close();
    const trajectoryReplay = await replayTrajectoryStream(trajectoryPath, { streamId: "trajectory-1" });
    assert.equal(trajectoryReplay.valid, true);
    assert.deepEqual(trajectoryReplay.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(trajectoryReplay.events[1].action, "trajectory_recovered");

    const trajectoryGapPath = join(dir, "trajectory-gap.jsonl");
    await writeFile(trajectoryGapPath, `${JSON.stringify(trajectoryRecord)}\n${JSON.stringify({ ...trajectoryRecord, seq: 3 })}\n`);
    const recoveredTrajectory = await recoverTrajectoryStream(trajectoryGapPath, { streamId: "trajectory-1" });
    assert.equal(recoveredTrajectory.recovered, true);
    assert.equal(recoveredTrajectory.events.at(-1).action, "trajectory_recovered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plan journal owns plan runtime paths and rebuilds checkpoint from replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plan-journal-"));
  try {
    const paths = planRuntimePaths({ root: dir, planId: "plan-1" });
    assert.equal(paths.events_path, join(dir, "docs/plans/.runtime/plan-1/events.jsonl"));
    assert.throws(() => planRuntimePaths({ root: dir, planId: ".." }), /Unsafe plan id/);
    const journal = await openPlanJournal({ root: dir, planId: "plan-1" });
    await journal.append("plan_started", { plan_id: "plan-1" }, { critical: true });
    await journal.append("test_passed", { command: "npm test" });
    await journal.close();
    const replay = await replayEventStream(paths.events_path, { streamId: "plan-plan-1" });
    assert.equal(replay.valid, true);
    assert.equal(replay.events.at(-1).type, "test_passed");
    assert.match(await readFile(paths.checkpoint_path, "utf8"), /last_event: test_passed/);

    const corruptPaths = planRuntimePaths({ root: dir, planId: "plan-2" });
    await mkdir(corruptPaths.plan_directory, { recursive: true });
    const planValid = { schema_version: 1, stream_id: "plan-plan-2", seq: 1, timestamp: "2026-01-01T00:00:00.000Z", type: "plan_started", payload: {} };
    await writeFile(corruptPaths.events_path, `${JSON.stringify(planValid)}\n${JSON.stringify({ ...planValid, seq: 3 })}\n`);
    const recoveredJournal = await openPlanJournal({ root: dir, planId: "plan-2" });
    await recoveredJournal.close();
    const recoveredReplay = await replayEventStream(corruptPaths.events_path, { streamId: "plan-plan-2" });
    assert.equal(recoveredReplay.valid, true);
    assert.equal(recoveredReplay.events.at(-1).type, "journal_recovered");
    assert.match(await readFile(corruptPaths.checkpoint_path, "utf8"), /recovery: sequence_gap/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external port denies mutation and replay mismatch without live fallback", async () => {
  const events = [];
  const port = await new ExternalSystemPort({ mode: "none", onEvent: async (event) => events.push(event) }).init();
    await assert.rejects(() => port.execute({ system: "github", operation: "update_issue", target: { issue: 1 }, payload: { status: "Done" } }), (error) => error.reason === "unauthorized_external_mutation");
    await assert.rejects(() => port.execute({ system: "github", operation: "create_issue", mutation: false, target: { repo: "fixture" }, payload: {} }), (error) => error.reason === "unauthorized_external_mutation");
  assert.equal(events[0].type, "unauthorized_external_mutation");

  const dir = await mkdtemp(join(tmpdir(), "harness-eval-recording-"));
  try {
    const fixture = join(dir, "recording.jsonl");
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, stream_id: "recording-github", seq: 1, request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, response: { ok: true } })}\n`);
    const replay = await new ExternalSystemPort({ mode: "replay", fixture }).init();
    assert.deepEqual(await replay.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }), { ok: true });
    await assert.rejects(() => replay.execute({ system: "github", operation: "read_issue", target: { issue: 2 }, payload: {} }), (error) => error.reason === "missing_external_recording");
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, stream_id: "recording-github", seq: 2, request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, response: { ok: true } })}\n`);
    await assert.rejects(() => new ExternalSystemPort({ mode: "replay", fixture }).init(), (error) => error.reason === "corrupted_recording_sequence");
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, stream_id: "recording-github", seq: 1, request: {}, response: { ok: true } })}\n`);
    await assert.rejects(() => new ExternalSystemPort({ mode: "replay", fixture }).init(), (error) => error.reason === "corrupted_fixture");
    await assert.rejects(() => validateRecordingFixture(fixture), (error) => error.reason === "corrupted_fixture");
    const runtimePath = join(dir, "runtime-recording.jsonl");
    const recorder = await new ExternalSystemPort({ mode: "none", runtimePath }).init();
    await recorder.record({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, { ok: true });
    await recorder.record({ system: "mcp", operation: "read_context", target: { name: "fixture" }, payload: {} }, { ok: true });
    const runtimeRecords = (await readFile(runtimePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(runtimeRecords.map((record) => [record.stream_id, record.seq]), [["recording", 1], ["recording", 2]]);
    const concurrentPath = join(dir, "concurrent-recording.jsonl");
    const concurrent = await new ExternalSystemPort({ mode: "none", runtimePath: concurrentPath }).init();
    await Promise.all(Array.from({ length: 30 }, (_, issue) => concurrent.record({ system: "github", operation: "read_issue", target: { issue }, payload: {} }, { ok: true, issue })));
    const concurrentRecords = (await readFile(concurrentPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(concurrentRecords.map((record) => record.seq), Array.from({ length: 30 }, (_, index) => index + 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live integration mutations stay inside the dedicated test resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-integration-"));
  const calls = [];
  const events = [];
  try {
    const port = await new ExternalSystemPort({
      mode: "live",
      integration: true,
      integrationResource: { system: "github", resource_id: "fixture", target: { repo: "fixture/repo" }, dedicated: true },
      runtimePath: join(dir, "recording.jsonl"),
      onEvent: async (event) => events.push(event),
      liveAdapter: async (request) => {
        calls.push(request);
        return { ok: true, resource_id: "fixture" };
      },
    }).init();
    assert.deepEqual(await port.execute({ system: "github", operation: "update_issue", target: { repo: "fixture/repo", issue: 1 }, payload: { status: "Done" } }), { ok: true, resource_id: "fixture" });
    await assert.rejects(
      () => port.execute({ system: "github", operation: "update_issue", target: { repo: "production/repo", issue: 1 }, payload: { status: "Done" } }),
      (error) => error instanceof EvalPolicyViolationError && error.reason === "unauthorized_external_mutation",
    );
    await assert.rejects(
      () => port.execute({ system: "github", operation: "read_issue", target: { repo: "production/repo", issue: 1 }, payload: {} }),
      (error) => error instanceof EvalPolicyViolationError && error.reason === "security_boundary_violation",
    );
    assert.equal(calls.length, 1);
    assert.equal(events.at(-1).type, "unauthorized_external_access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider adapters are explicit and reject cross-system requests", async () => {
  const github = await new GitHubStub().init();
  assert.equal((await github.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} })).system, "github");
  await assert.rejects(() => github.execute({ system: "mcp", operation: "read_context", target: { name: "fixture" }, payload: {} }), (error) => error.reason === "external_system_mismatch");

  const mcp = await new MCPStub().init();
  assert.equal((await mcp.execute({ system: "mcp", operation: "read_context", target: { name: "fixture" }, payload: {} })).system, "mcp");
  await assert.rejects(() => mcp.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }), (error) => error.reason === "external_system_mismatch");

  const githubRecording = await new GitHubRecordingAdapter({ mode: "replay", fixture: join(import.meta.dirname, "../evals/recordings/spec-me-source-policy.jsonl") }).init();
  await assert.rejects(() => githubRecording.execute({ system: "mcp", operation: "read_context", target: { name: "fixture" }, payload: {} }), (error) => error.reason === "external_system_mismatch");
  const mcpRecording = await new MCPRecordingAdapter({ mode: "none" }).init();
  await assert.rejects(() => mcpRecording.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }), (error) => error.reason === "external_system_mismatch");

  const integration = new ExplicitIntegrationAdapter({
    system: "github",
    integrationResource: { system: "github", resource_id: "fixture", target: { repo: "fixture/repo" }, dedicated: true },
    liveAdapter: async () => ({ ok: true }),
  });
  await integration.init();
  assert.deepEqual(await integration.execute({ system: "github", operation: "read_issue", target: { repo: "fixture/repo", issue: 1 }, payload: {} }), { ok: true });

  const routed = await createExternalSystemPort({ mode: "none" }).init();
  assert.ok(routed instanceof RoutedExternalSystemPort);
  assert.deepEqual((await routed.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} })).system, "github");
  assert.deepEqual((await routed.execute({ system: "mcp", operation: "read_context", target: { name: "fixture" }, payload: {} })).system, "mcp");
});

test("external-port subprocess persists shared recording and event evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-port-cli-"));
  try {
    const runtimePath = join(dir, "recording.jsonl");
    const eventsPath = join(dir, "external-events.jsonl");
    const result = await runProcess(process.execPath, [join(root, "bin/harness-external-port.mjs")], {
      cwd: root,
      env: { ...process.env, HARNESS_EVAL_CASE_ID: "port-cli", HARNESS_EVAL_EXTERNAL_PORT_MODE: "none", HARNESS_EVAL_EXTERNAL_RUNTIME: runtimePath, HARNESS_EVAL_EXTERNAL_EVENTS: eventsPath },
      stdio: ["pipe", "pipe", "pipe"],
    }, `${JSON.stringify({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} })}\n`);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"ok":true/);
    assert.equal((await replayEventStream(eventsPath, { streamId: "external-port-cli" })).events[0].type, "external_stub");
    assert.equal((await validateRecordingFixture(runtimePath)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external-port subprocess stops after a fail-fast mutation denial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-port-fail-fast-"));
  try {
    const requests = [1, 2].map((issue) => JSON.stringify({ system: "github", operation: "update_issue", target: { repo: "fixture/repo", issue }, payload: { status: "Done" } })).join("\n") + "\n";
    const result = await runProcess(process.execPath, [join(root, "bin/harness-external-port.mjs")], {
      cwd: root,
      env: { ...process.env, HARNESS_EVAL_CASE_ID: "port-fail-fast", HARNESS_EVAL_EXTERNAL_PORT_MODE: "none", HARNESS_EVAL_EXTERNAL_EVENTS: join(dir, "external-events.jsonl") },
      stdio: ["pipe", "pipe", "pipe"],
    }, requests);
    assert.equal(result.code, 3);
    const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)).filter((line) => line.type !== "ready");
    assert.equal(responses.length, 1);

    const port = await new ExternalPortSubprocess({
      command: [process.execPath, join(root, "bin/harness-external-port.mjs")],
      cwd: root,
      env: { ...process.env, HARNESS_EVAL_CASE_ID: "port-proxy-fail-fast", HARNESS_EVAL_EXTERNAL_PORT_MODE: "none", HARNESS_EVAL_EXTERNAL_EVENTS: join(dir, "proxy-events.jsonl") },
    }).init();
    await assert.rejects(() => port.execute({ system: "github", operation: "update_issue", target: { repo: "fixture/repo", issue: 1 }, payload: { status: "Done" } }), (error) => error.reason === "unauthorized_external_mutation");
    await port.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external-port subprocess reports startup failure and bounds cleanup", async () => {
  const failed = new ExternalPortSubprocess({ command: [process.execPath, "-e", "process.exit(1)"], env: { PATH: process.env.PATH } });
  await assert.rejects(() => failed.init(), (error) => error.reason === "external_provider_error");

  const hanging = await new ExternalPortSubprocess({ command: [process.execPath, "-e", "process.stdout.write(JSON.stringify({type: 'ready'}) + '\\n'); setInterval(() => {}, 10000)"], env: { PATH: process.env.PATH }, closeGraceMs: 20 }).init();
  const startedAt = Date.now();
  await hanging.close();
  assert.ok(Date.now() - startedAt < 1000);
});

test("quality delegates semantic scoring to the configured evaluator model", async () => {
  let received;
  const artifactBundle = {
    schema_version: 1,
    case_spec: { id: "case", workflow: "spec-me", required_outcome: ["spec_complete"] },
    normalized_trajectory: [{ kind: "tool_call", action: "write_file", payload: {} }],
    normalized_events: [],
    final_output: "[OUTCOME:spec_complete]",
    outcome_evidence: { passed: true, missing: [], results: { spec_complete: true } },
    relevant_diff: null,
  };
  const grader = new QualityGrader({
    model: "fixed-evaluator-v1",
    rubricVersion: "2",
    evaluator: async ({ artifactBundle: input, rubric }) => {
      received = { input, rubric };
      return { task_quality: 0.91, trajectory_quality: 0.73, dimensions: { requirement_coverage: 0.9 }, rationale: "semantic evaluator rationale" };
    },
  });
  const result = await grader.grade({ artifactBundle });
  assert.equal(received.input, artifactBundle);
  assert.match(received.rubric, /semantic quality/);
  assert.equal(result.quality, Number((0.65 * result.task_quality + 0.35 * result.trajectory_quality).toFixed(4)));
  assert.equal(result.efficiency, undefined);
  assert.equal(result.rationale, "semantic evaluator rationale");
  assert.deepEqual(result.evaluator_snapshot, { model: "fixed-evaluator-v1", rubric_version: "2" });
  assert.equal(detectTrajectoryViolation({ action: "read_file", target: "src/Foo.java" }, { forbidden_actions: [{ gate: "product_source_read_forbidden", action: "read_file", target_prefix: "src/" }] }, "/tmp/case" ).gate, "product_source_read_forbidden");
});

test("quality grader reports evaluator failures to the runner", async () => {
  await assert.rejects(
    () => new QualityGrader({ model: "fixed-evaluator-v1", evaluator: async () => { throw new Error("evaluator unavailable"); } }).grade({
      artifactBundle: {
        schema_version: 1,
        case_spec: { id: "case", workflow: "spec-me", required_outcome: ["spec_complete"] },
        normalized_trajectory: [],
        normalized_events: [],
        final_output: "done",
        outcome_evidence: { passed: true, missing: [], results: { spec_complete: true } },
        relevant_diff: null,
      },
    }),
    (error) => error.reason === "grader_execution_error",
  );
});

test("quality accepts semantic evaluator output without deterministic trajectory scoring", async () => {
  const result = await new QualityGrader({
    model: "fixed-evaluator-v1",
    evaluator: async () => ({ task_quality: 0.4, trajectory_quality: 0.6, dimensions: {}, rationale: "evaluated" }),
  }).grade({
    artifactBundle: {
      schema_version: 1,
      case_spec: { id: "case", workflow: "implement-wrapper", required_outcome: ["spec_complete"] },
      normalized_trajectory: [
        { kind: "tool_call", action: "command_execution", payload: { command: "cat plan.md" } },
        { kind: "tool_result", action: "command_execution", status: "success", payload: { command: "cat plan.md" } },
        { kind: "tool_call", action: "command_execution", payload: { command: "cat .codex/harness.yaml" } },
        { kind: "tool_result", action: "command_execution", status: "success", payload: { command: "cat .codex/harness.yaml" } },
      ],
      normalized_events: [],
      final_output: "done",
      outcome_evidence: { passed: true, missing: [], results: { spec_complete: true } },
      relevant_diff: null,
    },
  });
  assert.equal(result.trajectory_quality, 0.6);
});

test("hard gates inspect every normalized target in grouped evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-hidden-target-"));
  try {
    const sourceViolation = detectTrajectoryViolation({
      kind: "tool_call",
      action: "read_file",
      target: ".agents/skills/product-spec/SKILL.md",
      payload: { targets: [".agents/skills/product-spec/SKILL.md", "src/secret.txt"] },
    }, {
      forbidden_actions: [{ gate: "product_source_read_forbidden", action: "read_file", target_prefix: "src/" }],
    }, dir);
    assert.equal(sourceViolation.gate, "product_source_read_forbidden");

    const workspaceViolation = detectTrajectoryViolation({
      kind: "tool_result",
      action: "write_file",
      target: "safe.txt",
      payload: { changes: [{ path: "safe.txt", file_path: "../../outside.txt" }] },
    }, { forbidden_actions: [] }, dir);
    assert.equal(workspaceViolation.gate, "workspace_escape");
    assert.deepEqual(workspaceViolation.targets, ["safe.txt", "../../outside.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-zero agent exit is a failed execution even with otherwise valid evidence", () => {
  const result = finalizeCase({
    caseSpec: { id: "case", workflow: "spec-me", critical: false, quality_threshold: 0.75 },
    executionResult: { exitCode: 1, timedOut: false },
    cleanup: { state: "passed" },
    hardGates: { passed: true, violations: [] },
    outcome: { passed: true, results: {} },
    quality: { quality: 1 },
    efficiency: {},
  });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "agent_execution_failure");
});

test("required outcomes need structured evidence, not only final text or exit code", () => {
  const result = gradeOutcome({
    caseSpec: { required_outcome: ["spec_complete", "tests_passed"] },
    finalOutput: "[OUTCOME:spec_complete] [OUTCOME:tests_passed]",
    execution: { exitCode: 0 },
  });
  assert.deepEqual(result.results, { spec_complete: false, tests_passed: false });
  const messageOnly = gradeOutcome({
    caseSpec: { required_outcome: ["spec_complete"] },
    trajectory: [{ kind: "message", payload: { text: "[OUTCOME:spec_complete]" } }],
  });
  assert.equal(messageOnly.passed, false);
  const selfReportedProcessEvent = gradeOutcome({
    caseSpec: { required_outcome: ["spec_complete"], outcome_evidence: { spec_complete: { actions: ["spec_complete"], required_files: ["docs/specs/496/product-spec.md"] } } },
    trajectory: [{ kind: "process_event", actor: "harness", action: "spec_complete", payload: { outcome: "spec_complete" } }],
    artifactEvidence: { files: ["docs/specs/496/product-spec.md"] },
  });
  assert.equal(selfReportedProcessEvent.passed, false);
  const forgedToolResult = gradeOutcome({
    caseSpec: { required_outcome: ["spec_complete"], outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["output.md"] } } },
    trajectory: [{ kind: "tool_result", actor: "codex", correlation_id: "forged", action: "write_file", target: "output.md", status: "success" }],
    artifactEvidence: { files: ["output.md"] },
  });
  assert.equal(forgedToolResult.passed, false);
});

test("case identifiers are safe and dirty case workspaces become inconclusive", async () => {
  assert.throws(() => validateCaseManifest({
    schema_version: 1,
    id: "../escape",
    workflow: "spec-me",
    required_outcome: ["spec_complete"],
    outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["output.md"] } },
    hard_gates: ["product_source_read_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
  }), /safe path identifier/);
  assert.throws(() => validateCaseManifest({
    schema_version: 1,
    id: "safe-case",
    workflow: "spec-me",
    required_outcome: ["spec_complete"],
    outcome_evidence: { spec_complete: { actions: ["write_file"], required_files: ["output.md"] } },
    hard_gates: ["product_source_read_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
    environment: { env: { HARNESS_EVAL_WORKSPACE: "/outside" } },
  }), /reserved by the eval runner/);

  const dir = await mkdtemp(join(tmpdir(), "harness-eval-case-cleanup-"));
  try {
    const handle = await provisionCaseWorkspace({
      runDir: dir,
      caseSpec: { id: "cleanup-case" },
      root,
    });
    await writeFile(join(handle.isolatedCodexHome, "auth.json"), "case-secret\n", "utf8");
    const dirtyPath = join(handle.workspace, "dirty.txt");
    await writeFile(dirtyPath, "dirty\n");
    const dirty = await cleanupCaseWorkspace(handle, { evidencePersisted: true });
    assert.equal(dirty.state, "failed");
    assert.equal(dirty.reason, "worktree_leak");
    assert.equal(dirty.final_case_state, "inconclusive");
    assert.deepEqual(dirty.dirty_files, ["?? dirty.txt"]);
    await assert.rejects(() => readFile(join(handle.isolatedCodexHome, "auth.json")), { code: "ENOENT" });
    await unlink(dirtyPath);
    assert.equal((await cleanupCaseWorkspace(handle, { evidencePersisted: true })).state, "passed");

    const evidenceHandle = await provisionCaseWorkspace({
      runDir: dir,
      caseSpec: { id: "evidence-case" },
      root,
    });
    await writeFile(join(evidenceHandle.isolatedCodexHome, "auth.json"), "case-secret\n", "utf8");
    const evidenceBlocked = await cleanupCaseWorkspace(evidenceHandle, { evidencePersisted: false });
    assert.equal(evidenceBlocked.state, "failed");
    assert.equal(evidenceBlocked.reason, "workspace_cleanup_failure");
    await assert.rejects(() => readFile(join(evidenceHandle.isolatedCodexHome, "auth.json")), { code: "ENOENT" });
    assert.equal((await cleanupCaseWorkspace(evidenceHandle)).state, "failed");
    assert.equal((await cleanupCaseWorkspace(evidenceHandle, { evidencePersisted: true })).state, "passed");

    const credentialFailureHandle = await provisionCaseWorkspace({
      runDir: dir,
      caseSpec: { id: "credential-failure-case" },
      root,
    });
    const authPath = join(credentialFailureHandle.isolatedCodexHome, "auth.json");
    await mkdir(authPath);
    const credentialFailure = await cleanupCaseWorkspace(credentialFailureHandle, { evidencePersisted: true });
    assert.equal(credentialFailure.state, "failed");
    assert.equal(credentialFailure.reason, "workspace_cleanup_failure");
    assert.equal(credentialFailure.credential_cleanup.removed, false);
    await assert.rejects(() => readFile(authPath), { code: "EISDIR" });
    await rm(authPath, { recursive: true, force: false });
    assert.equal((await cleanupCaseWorkspace(credentialFailureHandle, { evidencePersisted: true })).state, "passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("case provisioning rejects nested fixture symlinks before copying", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "harness-eval-fixture-symlink-run-"));
  const fixture = await mkdtemp(join(tmpdir(), "harness-eval-fixture-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "harness-eval-fixture-outside-"));
  try {
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "must not be copied\n", "utf8");
    await symlink(outsideFile, join(fixture, "nested-link.txt"));
    await assert.rejects(
      () => provisionCaseWorkspace({ runDir, caseSpec: { id: "nested-symlink" }, root, fixturePath: fixture }),
      (error) => error.reason === "corrupted_fixture",
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("case workspace exposes installed Codex skill and role layout", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "harness-eval-runtime-layout-run-"));
  try {
    const handle = await provisionCaseWorkspace({ runDir, caseSpec: { id: "runtime-layout" }, root });
    assert.match(await readFile(join(handle.workspace, ".agents/skills/spec-me/SKILL.md"), "utf8"), /name: spec-me/);
    assert.match(await readFile(join(handle.workspace, ".codex/agents/spec_document_writer.toml"), "utf8"), /\.agents\/skills\/product-spec\/SKILL\.md/);
    await assert.rejects(() => readFile(join(handle.workspace, ".codex/skills/spec-me/SKILL.md")), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(handle.workspace, "docs/specs/496/product-spec.md")), { code: "ENOENT" });
    assert.equal((await cleanupCaseWorkspace(handle, { evidencePersisted: true })).state, "passed");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("runner produces a passing isolated P0 suite with an explicit command override", async () => {
  const emitter = join(root, "evals/fixtures/emit-eval.mjs");
  const result = await runSuiteForTest({ root, suiteId: "p0", runId: `test-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, emitter] });
  try {
    assert.equal(result.passed, true);
    assert.equal(result.counts.inconclusive, 0);
    assert.equal(result.baseline.environment_profile, "p0-default");
    const caseDir = join(result.run_dir, "cases", "spec-me-source-policy");
    assert.match(await readFile(join(caseDir, "checkpoint.md"), "utf8"), /last_event: case_finalized/);
    assert.match(await readFile(join(caseDir, "events.jsonl"), "utf8"), /workflow_dispatch_requested/);
    assert.match(await readFile(join(caseDir, "recording.jsonl"), "utf8"), /read_issue/);
    assert.match(await readFile(join(caseDir, "external-events.jsonl"), "utf8"), /external_replay/);
  } finally {
    await rm(result.run_dir, { recursive: true, force: true });
  }
});

test("runner records native permission denial separately from workflow violations", async () => {
  const deniedEvent = JSON.stringify({
    kind: "tool_result",
    actor: "codex",
    correlation_id: "native-denial-1",
    action: "read_file",
    target: ".eval-output/denied.txt",
    status: "denied",
    payload: { reason: "sandbox_denied" },
  });
  const commandOverride = ["/bin/sh", "-c", "printf '%s\\n' \"$1\"", "harness-eval", deniedEvent];
  const result = await runSuiteForTest({ root, suiteId: "p0", runId: `native-denial-${process.pid}-${Date.now()}`, commandOverride });
  try {
    assert.equal(result.counts.total, 4);
    for (const caseId of result.cases.map((item) => item.case_id)) {
      const events = (await readFile(join(result.run_dir, "cases", caseId, "events.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "native_permission_denied"));
      assert.equal(events.some((event) => event.type === "workflow_policy_violation"), false);
    }
  } finally {
    await rm(result.run_dir, { recursive: true, force: true });
  }
});

test("runner refuses to reuse a run id and preserves the first attempt", async () => {
  const emitter = join(root, "evals/fixtures/emit-eval.mjs");
  const id = `duplicate-${process.pid}-${Date.now()}`;
  const first = await runSuiteForTest({ root, suiteId: "p0", runId: id, commandOverride: [process.execPath, emitter] });
  try {
    const duplicate = await runSuiteForTest({ root, suiteId: "p0", runId: id, commandOverride: [process.execPath, emitter] });
    assert.equal(duplicate.state, "inconclusive");
    assert.equal(duplicate.reason, "duplicate_run_id");
    assert.equal(duplicate.phase, "preflight");
    assert.equal(duplicate.run_dir, first.run_dir);
    assert.equal((await readFile(join(first.run_dir, "result.json"), "utf8")).includes("duplicate_run_id"), false);
  } finally {
    await rm(first.run_dir, { recursive: true, force: true });
  }
});

test("runner terminates a case when a live hard cap is exceeded", async () => {
  const result = await runSuiteForTest({ root, suiteId: "p0", runId: `cap-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, join(root, "evals/fixtures/emit-loop.mjs")] });
  try {
    assert.deepEqual(result.cases.map((item) => item.reason), ["case_hard_cap_exceeded", "case_hard_cap_exceeded", "case_hard_cap_exceeded", "case_hard_cap_exceeded"]);
    const events = (await readFile(join(result.run_dir, "cases", "spec-me-source-policy", "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "case_hard_cap_exceeded").length, 1);
  } finally {
    await rm(result.run_dir, { recursive: true, force: true });
  }
});

test("default Codex command uses the native sandbox profile", () => {
  assert.deepEqual(resolveCodexCommand({
    caseSpec: { environment_profile: "p0-default" },
    config: { eval: { codex: { command: ["codex", "exec", "--json"] }, environment_profiles: { "p0-default": { sandbox: "workspace-write", network: "restricted" } } } },
  }), ["codex", "exec", "--json", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.network_access=false"]);
  assert.deepEqual(resolveCodexCommand({
    caseSpec: { environment_profile: "p0-default" },
    config: { eval: { codex: { command: ["codex", "exec", "--sandbox", "danger-full-access"] }, environment_profiles: { "p0-default": { sandbox: "workspace-write", network: "restricted" } } } },
  }), ["codex", "exec", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.network_access=false"]);
  assert.deepEqual(resolveCodexCommand({
    caseSpec: { environment_profile: "p0-default" },
    config: { eval: { codex: { command: ["codex", "exec", "--sandbox=danger-full-access", "--json"] }, environment_profiles: { "p0-default": { sandbox: "workspace-write", network: "restricted" } } } },
  }), ["codex", "exec", "--json", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.network_access=false"]);
  assert.throws(() => resolveCodexCommand({
    caseSpec: { environment_profile: "p0-default" },
    config: { eval: { codex: { command: ["node", "fake-runner.mjs"] }, environment_profiles: { "p0-default": { sandbox: "workspace-write", network: "restricted" } } } },
  }), /Codex CLI/);
});

test("Codex adapter emits normalized external requests without routing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-external-request-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-external-request" }).init();
    const adapter = new CodexProcessAdapter();
    const output = `console.log(${JSON.stringify(JSON.stringify({ kind: "tool_call", actor: "codex", correlation_id: "external-call-1", action: "external_request", payload: { request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} } } }))})`;
    const execution = await adapter.run({ command: [process.execPath, "-e", output], cwd: dir, trajectory });
    await trajectory.close();
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.records.length, 1);
    assert.equal(execution.records[0].action, "external_request");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter preserves structured external request targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-external-error-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-external-error" }).init();
    const adapter = new CodexProcessAdapter();
    const output = `console.log(${JSON.stringify(JSON.stringify({ kind: "tool_call", actor: "codex", correlation_id: "external-call-2", action: "external_request", target: { repo: "fixture/repo", issue: 2 }, payload: { request: { system: "github", operation: "read_issue", target: { repo: "fixture/repo", issue: 2 }, payload: {} } } }))})`;
    const execution = await adapter.run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.records[0].action, "external_request");
    assert.deepEqual(execution.records[0].target, { repo: "fixture/repo", issue: 2 });
    assert.equal(execution.records[0].correlation_id, "external-call-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter does not classify the shell executable as a workspace target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-shell-target-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-shell-target" }).init();
    const output = `console.log(${JSON.stringify(JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "/bin/zsh -lc 'cat .agents/skills/spec-me/SKILL.md'" },
    }))})`;
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.records[0].action, "command_execution");
    assert.equal(execution.records[0].target, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter normalizes Codex file changes into correlated write evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-file-change-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-file-change" }).init();
    const started = JSON.stringify({
      type: "item.started",
      item: { id: "change-1", type: "file_change", changes: [{ path: ".eval-output/result.md", kind: "add" }] },
    });
    const completed = JSON.stringify({
      type: "item.completed",
      item: { id: "change-1", type: "file_change", changes: [{ path: ".eval-output/result.md", kind: "add" }] },
    });
    const output = `console.log(${JSON.stringify(started)}); console.log(${JSON.stringify(completed)})`;
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.records[0].kind, "tool_call");
    assert.equal(execution.records[0].action, "write_file");
    assert.equal(execution.records[0].target, ".eval-output/result.md");
    assert.equal(execution.records[1].kind, "tool_result");
    assert.equal(execution.records[1].action, "write_file");
    assert.equal(execution.records[1].status, "success");
    assert.equal(execution.records[1].correlation_id, "change-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter makes absolute workspace file changes case-relative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-absolute-file-change-"));
  try {
    const target = join(dir, ".eval-output/result.md");
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-absolute-file-change" }).init();
    const started = JSON.stringify({
      type: "item.started",
      item: { id: "change-absolute", type: "file_change", changes: [{ path: target, kind: "add" }] },
    });
    const completed = JSON.stringify({
      type: "item.completed",
      item: { id: "change-absolute", type: "file_change", changes: [{ path: target, kind: "add" }] },
    });
    const output = `console.log(${JSON.stringify(started)}); console.log(${JSON.stringify(completed)})`;
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.records[0].target, ".eval-output/result.md");
    assert.equal(execution.records[1].payload.changes[0].path, ".eval-output/result.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter preserves every supported grouped file target field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-grouped-target-fields-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-grouped-target-fields" }).init();
    const outside = join(dir, "..", "outside.txt");
    const changes = [{
      path: ".eval-output/result.md",
      file: "safe-result.md",
      file_path: ".eval-output/result.md",
      workspace_path: outside,
      absolute_path: outside,
      kind: "add",
    }];
    const output = `console.log(${JSON.stringify(JSON.stringify({
      type: "item.completed",
      item: { id: "grouped-targets", type: "file_change", changes },
    }))})`;
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    const record = execution.records[0];
    assert.equal(record.payload.changes[0].file, "safe-result.md");
    assert.equal(record.payload.changes[0].workspace_path, outside);
    assert.equal(detectTrajectoryViolation(record, { forbidden_actions: [] }, dir).gate, "workspace_escape");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter does not classify stderr redirection to dev null as a write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-stderr-redirect-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-stderr-redirect" }).init();
    const output = JSON.stringify({
      type: "item.started",
      item: { id: "command-redirect", type: "command_execution", command: "/bin/zsh -lc \"pwd; rg --files .eval-output 2>/dev/null\"" },
    });
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", `console.log(${JSON.stringify(output)})`],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.notEqual(execution.records[0].action, "write_file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter normalizes eval-output writes from structured command events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-command-write-"));
  try {
    const trajectory = await new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-command-write" }).init();
    const command = "python -c 'Path(\".eval-output/specs/496/product-spec.md\").write_text(\"spec\")'";
    const started = JSON.stringify({
      type: "item.started",
      item: { id: "command-1", type: "command_execution", command },
    });
    const completed = JSON.stringify({
      type: "item.completed",
      item: { id: "command-1", type: "command_execution", command, exit_code: 0 },
    });
    const output = `console.log(${JSON.stringify(started)}); console.log(${JSON.stringify(completed)})`;
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", output],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    assert.equal(execution.records[0].action, "write_file");
    assert.equal(execution.records[1].action, "write_file");
    assert.equal(execution.records[1].target, ".eval-output/specs/496/product-spec.md");
    assert.equal(execution.records[1].payload.targets, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outcome evidence matches any path in a grouped file-change result", () => {
  const paths = [
    ".eval-output/specs/496/ambiguity-resolved.json",
    ".eval-output/specs/496/product-spec.md",
  ];
  const result = gradeOutcome({
    caseSpec: {
      required_outcome: ["spec_complete"],
      outcome_evidence: {
        spec_complete: {
          actions: ["write_file"],
          target_prefix: ".eval-output/specs/496/product-spec.md",
          required_files: [".eval-output/specs/496/product-spec.md"],
        },
      },
    },
    trajectory: [
      { kind: "tool_call", correlation_id: "change-1", action: "write_file", target: paths[0], payload: { changes: paths.map((path) => ({ path })) } },
      { kind: "tool_result", correlation_id: "change-1", action: "write_file", target: paths[0], status: "success", payload: { changes: paths.map((path) => ({ path })) } },
    ],
    artifactEvidence: { files: [".eval-output/specs/496/product-spec.md"] },
  });
  assert.equal(result.passed, true);
});

test("outcome correlation compares normalized structured targets by value", () => {
  const result = gradeOutcome({
    caseSpec: { required_outcome: ["review_complete"], outcome_evidence: { review_complete: { actions: ["review_verdict"], required_files: ["review.json"] } } },
    trajectory: [
      { kind: "tool_call", correlation_id: "review-1", action: "review_verdict", target: { reviewers: ["spec", "standards"] } },
      { kind: "tool_result", correlation_id: "review-1", action: "review_verdict", target: { reviewers: ["spec", "standards"] }, status: "success" },
    ],
    artifactEvidence: { files: ["review.json"] },
  });
  assert.equal(result.passed, true);
});

test("structured file targets outside the workspace are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-target-"));
  try {
    await assert.rejects(() => assertWorkspaceTarget(dir, { path: "/outside/file.txt" }), (error) => error.reason === "workspace_escape");
    assert.equal(detectTrajectoryViolation({ action: "read_file", target: { path: "/outside/file.txt" } }, { forbidden_actions: [] }, dir).gate, "workspace_escape");
    assert.equal(detectTrajectoryViolation({ action: "inspect", target: "../../outside/file.txt" }, { forbidden_actions: [] }, dir).gate, "workspace_escape");
    assert.equal(detectTrajectoryViolation({ action: "inspect", target: { path: "safe.txt", absolute_path: "/outside/file.txt" } }, { forbidden_actions: [] }, dir).gate, "workspace_escape");
    assert.equal(detectTrajectoryViolation({ action: "inspect", target: "..\\outside\\file.txt" }, { forbidden_actions: [] }, dir).gate, "workspace_escape");
    await assert.rejects(() => assertWorkspaceTarget(dir, { path: "safe.txt", absolute_path: "/outside/file.txt" }), (error) => error.reason === "workspace_escape");
    await assert.rejects(() => assertWorkspaceTarget(dir, { file: "..\\outside\\file.txt" }), (error) => error.reason === "workspace_escape");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structured POSIX file targets inside the workspace are accepted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-target-inside-"));
  try {
    const target = join(dir, "output.md");
    await writeFile(target, "fixture\n", "utf8");
    assert.equal(await assertWorkspaceTarget(dir, target), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter does not inherit unspecified host secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-env-"));
  const previous = process.env.HARNESS_EVAL_HOST_SECRET;
  process.env.HARNESS_EVAL_HOST_SECRET = "must-not-leak";
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-env" });
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", "process.stdout.write(process.env.HARNESS_EVAL_HOST_SECRET || 'absent')"],
      cwd: dir,
      trajectory,
    });
    assert.match(execution.finalOutput, /absent/);
    assert.doesNotMatch(execution.finalOutput, /must-not-leak/);
  } finally {
    await trajectory.close();
    if (previous === undefined) delete process.env.HARNESS_EVAL_HOST_SECRET;
    else process.env.HARNESS_EVAL_HOST_SECRET = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter redacts command credentials in process evidence and snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-command-redaction-"));
  const trajectoryPath = join(dir, "trajectory.jsonl");
  const trajectory = new TrajectoryWriter(trajectoryPath, { streamId: "trajectory-command-redaction" });
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", "process.exit(0)", "--token", "command-secret"],
      cwd: dir,
      trajectory,
    });
    await trajectory.close();
    const evidence = await readFile(trajectoryPath, "utf8");
    assert.doesNotMatch(evidence, /command-secret/);
    assert.deepEqual(execution.command.slice(-2), ["--token", "[REDACTED]"]);
    assert.deepEqual(execution.snapshot.command.slice(-2), ["--token", "[REDACTED]"]);
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter classifies authentication failures as inconclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-auth-failure-"));
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-auth-failure" });
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", "console.error('failed to connect: 401 Unauthorized Missing bearer authentication'); process.exit(1)"],
      cwd: dir,
      trajectory,
    });
    assert.equal(execution.exitCode, 1);
    assert.equal(execution.inconclusiveReason, "codex_authentication_unavailable");
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter classifies provider disconnects as inconclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-provider-failure-"));
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-provider-failure" });
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", "console.error('stream disconnected before completion: failed to lookup address information: Try again')"],
      cwd: dir,
      trajectory,
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.inconclusiveReason, "codex_provider_unavailable");
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter classifies provider usage limits as inconclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-usage-limit-"));
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-usage-limit" });
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter().run({
      command: [process.execPath, "-e", "console.error(\\\"You've hit your usage limit. Upgrade to Pro.\\\"); process.exit(1)"],
      cwd: dir,
      trajectory,
    });
    assert.equal(execution.inconclusiveReason, "codex_usage_limit");
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval Codex auth mode always resolves a case-local CODEX_HOME", () => {
  const workspace = "/tmp/harness-eval-auth/workspace";
  assert.equal(
    resolveCodexHome({
      workspace,
      config: { eval: { codex: { auth_mode: "inherited" } } },
      environment: { HOME: "/home/eval", CODEX_HOME: "/home/eval/.codex" },
    }),
    `${workspace}/.eval-codex-home`,
  );
  assert.equal(
    resolveCodexHome({
      workspace,
      config: { eval: { codex: { auth_mode: "inherited" } } },
      environment: { HOME: "/home/eval" },
    }),
    `${workspace}/.eval-codex-home`,
  );
  assert.equal(
    resolveCodexHome({
      workspace,
      config: { eval: { codex: { auth_mode: "isolated" } } },
      environment: { HOME: "/home/eval", CODEX_HOME: "/home/eval/.codex" },
    }),
    `${workspace}/.eval-codex-home`,
  );
});

test("inherited Codex auth is seeded into a per-case home without passing the host path", async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), "harness-eval-auth-source-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-auth-workspace-"));
  try {
    await mkdir(join(workspace, ".eval-codex-home"), { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), "{\"access_token\":\"redacted-test-token\"}\n", { mode: 0o600 });
    const config = { eval: { codex: { auth_mode: "inherited" } } };
    assert.equal(await seedCodexAuth({ workspace, config, environment: { CODEX_HOME: sourceHome } }), true);
    assert.equal(resolveCodexHome({ workspace, config }), join(workspace, ".eval-codex-home"));
    assert.equal(await readFile(join(workspace, ".eval-codex-home/auth.json"), "utf8"), "{\"access_token\":\"redacted-test-token\"}\n");
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex adapter signals a long-running process on timeout", { timeout: 3000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-timeout-"));
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-timeout" });
  let terminated = 0;
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter({ killGraceMs: 20 }).run({
      command: [process.execPath, "-e", "setInterval(() => {}, 10000)"],
      cwd: dir,
      timeoutMs: 50,
      trajectory,
      onTerminate: async () => { terminated += 1; },
    });
    assert.equal(execution.timedOut, true);
    assert.equal(terminated, 1);
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter signals a long-running process on fail-fast termination", { timeout: 3000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-fail-fast-"));
  const trajectory = new TrajectoryWriter(join(dir, "trajectory.jsonl"), { streamId: "trajectory-fail-fast" });
  let terminated = 0;
  try {
    await trajectory.init();
    const execution = await new CodexProcessAdapter({ killGraceMs: 20 }).run({
      command: [process.execPath, "-e", "console.log(JSON.stringify({kind: 'message', actor: 'codex', payload: {text: 'trigger'}})); setInterval(() => {}, 10000)"],
      cwd: dir,
      trajectory,
      onRecord: async (_record, control) => control.terminate(),
      onTerminate: async () => { terminated += 1; },
    });
    assert.equal(execution.timedOut, false);
    assert.equal(terminated, 1);
  } finally {
    await trajectory.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduler parallelizes only independent runnable plans", () => {
  const plans = [
    { id: "a", dependencies: [], resources: ["filesystem:src/a"] },
    { id: "b", dependencies: [], resources: ["filesystem:src/b"] },
    { id: "c", dependencies: ["a"], resources: ["filesystem:src/c"] },
  ];
  const initial = schedulePlans(plans, { fixedGroupBase: "abc123" });
  assert.deepEqual(initial.groups, [{ type: "parallel", planIds: ["a", "b"], fixed_group_base: "abc123", workspace: "isolated_worktree" }]);
  const afterA = schedulePlans(plans, { completedPlanIds: ["a"], fixedGroupBase: "def456" });
  assert.deepEqual(afterA.groups, [{ type: "parallel", planIds: ["b", "c"], fixed_group_base: "def456", workspace: "isolated_worktree" }]);
  assert.equal(new ResourceGraph(plans).conflicts("a", "b"), false);
  assert.equal(schedulePlans([{ id: "unknown-a", dependencies: [] }, { id: "unknown-b", dependencies: [] }], { fixedGroupBase: "abc123" }).groups[0].type, "sequential");
  assert.equal(schedulePlans([{ id: "same-a", dependencies: [], resources: ["filesystem:src"] }, { id: "same-b", dependencies: [], resources: ["filesystem:src"] }], { fixedGroupBase: "abc123" }).groups[0].type, "sequential");
  assert.equal(schedulePlans(plans).groups[0].type, "sequential");
});

test("worktree manager uses one fixed detached base and refuses dirty cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-worktree-"));
  const repo = join(dir, "repo");
  const runtime = join(dir, "runtime");
  try {
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "eval@example.invalid"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Eval"]);
    await writeFile(join(repo, "README.md"), "fixture\n");
    await execFileAsync("git", ["-C", repo, "add", "README.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
    const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const manager = new WorktreeManager({ repoRoot: repo, runtimeRoot: runtime });
    const first = await manager.allocate({ planId: "a", fixedGroupBase: base, groupId: "group-1" });
    const second = await manager.allocate({ planId: "b", fixedGroupBase: base, groupId: "group-1" });
    assert.equal(first.baseSha, base);
    assert.equal(second.baseSha, base);
    assert.notEqual(first.workspace, second.workspace);
    assert.equal((await execFileAsync("git", ["-C", first.workspace, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "HEAD");
    assert.equal((await manager.verify(second)).valid, true);
    assert.equal((await manager.cleanup(first, { evidencePersisted: true })).cleanup.state, "passed");
    await writeFile(join(second.workspace, "dirty.txt"), "dirty\n");
    const dirtyVerification = await manager.verify(second);
    assert.equal(dirtyVerification.valid, false);
    assert.equal(dirtyVerification.reason, "worktree_dirty");
    assert.deepEqual(dirtyVerification.dirty_files, ["?? dirty.txt"]);
    const dirty = await manager.cleanup(second, { evidencePersisted: true });
    assert.equal(dirty.cleanup.reason, "worktree_leak");
    assert.equal(manager.isPoolBlocked("group-1"), true);
    await assert.rejects(() => manager.allocate({ planId: "blocked", fixedGroupBase: base, groupId: "group-1" }));
    await unlink(join(second.workspace, "dirty.txt"));
    assert.equal((await manager.cleanup(second, { evidencePersisted: true })).cleanup.state, "passed");
    assert.equal(manager.isPoolBlocked("group-1"), false);
    const scheduled = await runScheduledPlanGroup({
      plans: [
        { id: "scheduled-a", dependencies: [], resources: ["filesystem:src/a"] },
        { id: "scheduled-b", dependencies: [], resources: ["filesystem:src/b"] },
      ],
      fixedGroupBase: base,
      manager,
      runPlan: async (_plan, handle) => ({ evidencePersisted: true, workspace: handle.workspace }),
    });
    assert.deepEqual(scheduled.results.map((item) => item.cleanup.state), ["passed", "passed"]);
    assert.notEqual(scheduled.results[0].workspace, scheduled.results[1].workspace);
    const sequential = await runScheduledPlanGroup({
      plans: [
        { id: "sequential-a", dependencies: [], resources: ["filesystem:shared"] },
        { id: "sequential-b", dependencies: [], resources: ["filesystem:shared"] },
      ],
      executionLine: repo,
      manager,
      runPlan: async (_plan) => ({ evidencePersisted: true }),
    });
    assert.deepEqual(sequential.results.map((item) => item.cleanup.state), ["passed", "passed"]);
    assert.deepEqual(sequential.results.map((item) => item.finalHeadSha), [base, base]);
    const dirtySequentialHandle = await manager.allocate({ planId: "dirty-sequential", mode: "sequential", executionLine: repo });
    await writeFile(join(repo, "dirty-sequential.txt"), "dirty\n");
    const dirtySequential = await manager.cleanup(dirtySequentialHandle, { evidencePersisted: true });
    assert.equal(dirtySequential.cleanup.reason, "worktree_leak");
    assert.equal(manager.isExecutionLineBlocked(repo), true);
    await assert.rejects(() => manager.allocate({ planId: "blocked-sequential", mode: "sequential", executionLine: repo }), /Execution line is blocked/);
    await unlink(join(repo, "dirty-sequential.txt"));
    assert.equal((await manager.cleanup(dirtySequentialHandle, { evidencePersisted: true })).cleanup.state, "passed");
    assert.equal(manager.isExecutionLineBlocked(repo), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
