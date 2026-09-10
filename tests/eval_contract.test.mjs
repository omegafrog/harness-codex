import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { loadHarnessConfig, loadSuite } from "../src/eval/case-loader.mjs";
import { resolveCodexCommand } from "../src/eval/codex-adapter.mjs";
import { detectTrajectoryViolation } from "../src/eval/graders/hard-gates.mjs";
import { QualityGrader } from "../src/eval/graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter, projectCheckpoint, recoverEventStream, replayEventStream } from "../src/eval/journal.mjs";
import { ExternalSystemPort } from "../src/eval/recording.mjs";
import { runSuite } from "../src/eval/runner.mjs";
import { ResourceGraph, WorktreeManager, runScheduledPlanGroup, schedulePlans } from "../src/eval/workspace.mjs";

const root = join(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

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
    assert.equal(await readFile(`${path}.corrupt/000002.jsonl`, "utf8"), '{"schema_version":1,"stream_id":"plan-1"');
    const recovered = await recoverEventStream(path, { streamId: "plan-1" });
    assert.equal(recovered.events.at(-1).type, "journal_recovered");
    const repaired = await replayEventStream(path, { streamId: "plan-1" });
    assert.equal(repaired.valid, true);
    const checkpoint = join(dir, "checkpoint.md");
    await projectCheckpoint(recovered.events, checkpoint, { streamId: "plan-1", corruption: replay.corruption });
    const checkpointText = await readFile(checkpoint, "utf8");
    assert.match(checkpointText, /last_seq: 2/);
    assert.match(checkpointText, /recovery: malformed_final_line/);

    const gapPath = join(dir, "gap.jsonl");
    await writeFile(gapPath, `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, seq: 3 })}\n`);
    const gap = await replayEventStream(gapPath, { streamId: "plan-1" });
    assert.equal(gap.corruption.kind, "sequence_gap");
    const duplicatePath = join(dir, "duplicate.jsonl");
    await writeFile(duplicatePath, `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`);
    const duplicate = await replayEventStream(duplicatePath, { streamId: "plan-1" });
    assert.equal(duplicate.corruption.kind, "duplicate_sequence");
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
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, stream_id: "recording-github", seq: 1, request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, response: { ok: true } })}\n`);
    const replay = await new ExternalSystemPort({ mode: "replay", fixture }).init();
    assert.deepEqual(await replay.execute({ system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }), { ok: true });
    await assert.rejects(() => replay.execute({ system: "github", operation: "read_issue", target: { issue: 2 }, payload: {} }), (error) => error.reason === "missing_external_recording");
    await writeFile(fixture, `${JSON.stringify({ schema_version: 1, stream_id: "recording-github", seq: 2, request: { system: "github", operation: "read_issue", target: { issue: 1 }, payload: {} }, response: { ok: true } })}\n`);
    await assert.rejects(() => new ExternalSystemPort({ mode: "replay", fixture }).init(), (error) => error.reason === "corrupted_recording_sequence");
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

test("runner terminates a case when a live hard cap is exceeded", async () => {
  const script = "for (let i=0;i<30;i++) console.log(JSON.stringify({kind:\"message\",actor:\"codex\",payload:{text:\"loop\"}}));";
  const result = await runSuite({ root, suiteId: "p0", runId: `cap-${process.pid}-${Date.now()}`, commandOverride: [process.execPath, "-e", script] });
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
    config: { eval: { codex: { command: ["codex", "exec", "--json"] }, environment_profiles: { "p0-default": { sandbox: "workspace-write" } } } },
  }), ["codex", "exec", "--json", "--sandbox", "workspace-write"]);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
