import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { loadHarnessConfig, loadSuite, validateCaseManifest } from "../src/eval/case-loader.mjs";
import { CodexProcessAdapter, resolveCodexCommand } from "../src/eval/codex-adapter.mjs";
import { detectTrajectoryViolation } from "../src/eval/graders/hard-gates.mjs";
import { gradeOutcome } from "../src/eval/graders/outcome.mjs";
import { QualityGrader } from "../src/eval/graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter, projectCheckpoint, recoverEventStream, recoverTrajectoryStream, replayEventStream, replayTrajectoryStream } from "../src/eval/journal.mjs";
import { ExternalSystemPort } from "../src/eval/recording.mjs";
import { openPlanJournal, planRuntimePaths } from "../src/eval/plan-journal.mjs";
import { finalizeCase } from "../src/eval/report.mjs";
import { runSuite } from "../src/eval/runner.mjs";
import { cleanupCaseWorkspace, provisionCaseWorkspace } from "../src/eval/case-workspace.mjs";
import { ResourceGraph, WorktreeManager, runScheduledPlanGroup, schedulePlans } from "../src/eval/plan-workspace.mjs";
import { EvalPolicyViolationError } from "../src/eval/errors.mjs";

const root = join(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

test("loads versioned suite and registry-backed case contracts", async () => {
  const config = await loadHarnessConfig(root);
  const suite = await loadSuite(root, "p0", config);
  assert.equal(suite.cases.length, 4);
  assert.deepEqual(suite.cases[0].required_outcome, ["spec_complete", "ambiguity_resolved"]);
  assert.equal(suite.baseline.environment_profile, "p0-default");
});

test("live integration cases require an explicitly dedicated resource", () => {
  const base = {
    schema_version: 1,
    id: "integration-case",
    workflow: "code-review",
    required_outcome: ["review_verdict_preserved"],
    hard_gates: ["reviewer_write_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
    integration: true,
    recording: { mode: "live" },
  };
  assert.throws(() => validateCaseManifest(base), /integration_resource is required/);
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
});

test("case identifiers are safe and dirty case workspaces become inconclusive", async () => {
  assert.throws(() => validateCaseManifest({
    schema_version: 1,
    id: "../escape",
    workflow: "spec-me",
    required_outcome: ["spec_complete"],
    hard_gates: ["product_source_read_forbidden"],
    quality_threshold: 0.75,
    hard_caps: {},
  }), /safe path identifier/);
  assert.throws(() => validateCaseManifest({
    schema_version: 1,
    id: "safe-case",
    workflow: "spec-me",
    required_outcome: ["spec_complete"],
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
    const dirtyPath = join(handle.workspace, "dirty.txt");
    await writeFile(dirtyPath, "dirty\n");
    const dirty = await cleanupCaseWorkspace(handle, { evidencePersisted: true });
    assert.equal(dirty.state, "failed");
    assert.equal(dirty.reason, "worktree_leak");
    assert.equal(dirty.final_case_state, "inconclusive");
    assert.deepEqual(dirty.dirty_files, ["?? dirty.txt"]);
    await unlink(dirtyPath);
    assert.equal((await cleanupCaseWorkspace(handle, { evidencePersisted: true })).state, "passed");

    const evidenceHandle = await provisionCaseWorkspace({
      runDir: dir,
      caseSpec: { id: "evidence-case" },
      root,
    });
    const evidenceBlocked = await cleanupCaseWorkspace(evidenceHandle, { evidencePersisted: false });
    assert.equal(evidenceBlocked.state, "failed");
    assert.equal(evidenceBlocked.reason, "workspace_cleanup_failure");
    assert.equal((await cleanupCaseWorkspace(evidenceHandle)).state, "failed");
    assert.equal((await cleanupCaseWorkspace(evidenceHandle, { evidencePersisted: true })).state, "passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner produces a passing isolated P0 suite with an explicit command override", async () => {
  const emitter = join(root, "evals/fixtures/emit-eval.mjs");
  const result = await runSuite({ root, suiteId: "p0", runId: `test-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, emitter] });
  try {
    assert.equal(result.passed, true);
    assert.equal(result.counts.inconclusive, 0);
    assert.equal(result.baseline.environment_profile, "p0-default");
    assert.match(await readFile(join(result.run_dir, "cases", "spec-me-source-policy", "checkpoint.md"), "utf8"), /last_event: case_finalized/);
  } finally {
    await rm(result.run_dir, { recursive: true, force: true });
  }
});

test("runner terminates a case when a live hard cap is exceeded", async () => {
  const result = await runSuite({ root, suiteId: "p0", runId: `cap-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, join(root, "evals/fixtures/emit-loop.mjs")] });
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
    assert.equal((await manager.cleanup(first, { evidencePersisted: true })).cleanup.state, "passed");
    await writeFile(join(second.workspace, "dirty.txt"), "dirty\n");
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
