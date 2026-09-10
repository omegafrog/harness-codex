import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadHarnessConfig, loadSuite, resolveFixture } from "./case-loader.mjs";
import { CodexProcessAdapter, resolveCodexCommand } from "./codex-adapter.mjs";
import { EvalInconclusiveError, ManifestValidationError } from "./errors.mjs";
import { gradeHardGates, detectTrajectoryViolation } from "./graders/hard-gates.mjs";
import { gradeOutcome } from "./graders/outcome.mjs";
import { collectEfficiency, QualityGrader } from "./graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter } from "./journal.mjs";
import { ExternalSystemPort } from "./recording.mjs";
import { evaluateSuite, finalizeCase, persistReport } from "./report.mjs";
import { ensureDir, writeJsonAtomic } from "./util.mjs";
import { provisionCaseWorkspace, cleanupCaseWorkspace } from "./workspace.mjs";

function runId() {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
}

async function copyFixture(fixture, caseDir) {
  if (!fixture) return null;
  const destination = join(caseDir, "fixture");
  await cp(fixture, destination, { recursive: true, force: false, errorOnExist: false });
  return destination;
}

function hardCapExceeded(caseSpec, trajectory, execution) {
  const caps = caseSpec.hard_caps;
  const toolCalls = trajectory.filter((record) => record.kind === "tool_call").length;
  const turns = trajectory.filter((record) => record.kind === "message" && record.actor === "codex").length;
  const tokens = Number(execution.tokens || trajectory.reduce((sum, record) => sum + Number(record.payload?.tokens || 0), 0));
  return (caps.max_turns && turns > caps.max_turns) || (caps.max_tool_calls && toolCalls > caps.max_tool_calls) || (caps.max_tokens && tokens > caps.max_tokens);
}

function caseEnvironment(caseSpec, config, workspace, runDir) {
  return {
    HARNESS_EVAL_CASE_ID: caseSpec.id,
    HARNESS_EVAL_WORKSPACE: workspace,
    HARNESS_EVAL_RUN_DIR: runDir,
    HARNESS_EVAL_ENVIRONMENT_PROFILE: caseSpec.environment_profile,
    HARNESS_EVAL_CASE_MANIFEST: caseSpec.path,
    ...(caseSpec.environment?.env || {}),
    ...(config.eval.environment?.env || {}),
  };
}

async function runCase({ root, runDir, config, caseSpec, commandOverride = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  await ensureDir(caseDir);
  const events = new JsonlEventWriter(join(caseDir, "events.jsonl"), { streamId: `case-${caseSpec.id}` });
  const trajectory = new TrajectoryWriter(join(caseDir, "trajectory.jsonl"), { streamId: `trajectory-${caseSpec.id}` });
  await events.init();
  await trajectory.init();
  const startedAt = Date.now();
  let workspaceHandle = null;
  let execution = { exitCode: null, processError: null, inconclusiveReason: null, timedOut: false, durationMs: 0, command: null };
  let hardGates = { passed: true, violations: [] };
  let outcome = { passed: false, results: {}, missing: caseSpec.required_outcome };
  let quality = null;
  let efficiency = { tokens: 0, latency_ms: 0, tool_calls: 0, turns: 0, handoffs: 0 };
  await events.append("case_started", { case_id: caseSpec.id, workflow: caseSpec.workflow }, { critical: true });
  try {
    const fixture = resolveFixture(root, caseSpec);
    workspaceHandle = await provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath: fixture });
    const recordingFixture = caseSpec.recording.mode === "replay" ? resolve(root, caseSpec.recording.fixture) : null;
    const external = await new ExternalSystemPort({
      mode: caseSpec.recording.mode,
      fixture: recordingFixture,
      runtimePath: join(caseDir, "recording.jsonl"),
      integration: caseSpec.integration,
      onEvent: async (event) => events.append(event.type, event.payload || {}, { critical: true }),
    }).init();
    const adapter = new CodexProcessAdapter();
    let failFast = false;
    const onRecord = async (record, control) => {
      if (record.status === "denied") {
        await events.append("native_permission_denied", { action: record.action, target: record.target, actor: record.actor }, { critical: true });
      }
      const violation = detectTrajectoryViolation(record, caseSpec, workspaceHandle.workspace);
      if (violation) {
        await events.append("hard_gate_violation", violation, { critical: true, extra: { gate: violation.gate, mode: violation.mode } });
        if (violation.mode === "fail_fast") {
          failFast = true;
          control.terminate();
        }
      }
    };
    const command = resolveCodexCommand({ caseSpec, config, commandOverride });
    const prompt = caseSpec.scenario?.prompt || `Execute eval case ${caseSpec.id}`;
    execution = await adapter.run({
      command,
      cwd: workspaceHandle.workspace,
      env: caseEnvironment(caseSpec, config, workspaceHandle.workspace, runDir),
      stdin: prompt,
      timeoutMs: caseSpec.hard_caps.max_latency_ms || null,
      trajectory,
      onRecord,
      onEvent: async (event) => events.append(event.type, event.payload || {}, { critical: event.type === "process_started" }),
      caseId: caseSpec.id,
    });
    execution.failFast = failFast;
    execution.hardCapExceeded = hardCapExceeded(caseSpec, execution.records, execution);
    if (execution.processError) execution.inconclusiveReason = "codex_process_crash_unattributable_to_case";
    const eventText = await readFile(join(caseDir, "events.jsonl"), "utf8");
    const eventRecords = eventText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    hardGates = gradeHardGates({ caseSpec, trajectory: execution.records, events: eventRecords });
    outcome = gradeOutcome({ caseSpec, trajectory: execution.records, events: eventRecords, finalOutput: execution.finalOutput, execution });
    efficiency = collectEfficiency({ trajectory: execution.records, execution, startedAt, finishedAt: Date.now() });
    try {
      quality = new QualityGrader({ model: config.eval.quality_grader?.model || "deterministic-v1", rubricVersion: config.eval.quality_grader?.rubric_version || "1" }).grade({
        caseSpec,
        artifactBundle: {
          case_spec: { id: caseSpec.id, workflow: caseSpec.workflow },
          normalized_trajectory: execution.records,
          normalized_events: eventRecords,
          final_output: execution.finalOutput,
          relevant_diff: null,
          outcome_evidence: outcome,
        },
      });
    } catch (error) {
      throw new EvalInconclusiveError("grader_execution_error", `Quality grader failed: ${error.message}`, { cause: error });
    }
    await writeJsonAtomic(join(caseDir, "execution.json"), { ...execution, stdout: undefined, stderr: undefined, processError: undefined });
    await writeJsonAtomic(join(caseDir, "final-output.json"), { output: execution.finalOutput });
  } catch (error) {
    if (error instanceof ManifestValidationError) execution.inconclusiveReason = error.reason;
    else if (error instanceof EvalInconclusiveError && error.reason === "unauthorized_external_mutation") {
      await events.append("hard_gate_violation", { gate: "unauthorized_external_mutation", mode: "fail_fast" }, { critical: true, extra: { gate: "unauthorized_external_mutation", mode: "fail_fast" } });
      execution.inconclusiveReason = null;
    } else if (error instanceof EvalInconclusiveError) execution.inconclusiveReason = error.reason;
    else execution.inconclusiveReason = "harness_runner_crash";
    await events.append("case_error", { reason: execution.inconclusiveReason, message: error.message }, { critical: true });
    efficiency = collectEfficiency({ trajectory: [], execution, startedAt, finishedAt: Date.now() });
  }
  await trajectory.close();
  await events.append("evidence_flushed", { case_id: caseSpec.id }, { critical: true });
  await events.close();
  const cleanup = workspaceHandle ? await cleanupCaseWorkspace(workspaceHandle) : { state: "passed", reason: null };
  const eventText = await readFile(join(caseDir, "events.jsonl"), "utf8");
  const eventRecords = eventText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (!quality) quality = { task_quality: 0, trajectory_quality: 0, quality: 0, dimensions: {}, rationale: "평가 불가", evaluator_snapshot: null };
  if (!hardGates || hardGates.passed === undefined) hardGates = gradeHardGates({ caseSpec, events: eventRecords });
  const result = finalizeCase({ caseSpec, executionResult: execution, cleanup, hardGates, outcome, quality, efficiency, artifacts: { case_dir: caseDir, event_stream: join(caseDir, "events.jsonl"), trajectory: join(caseDir, "trajectory.jsonl"), recording: join(caseDir, "recording.jsonl") } });
  await writeJsonAtomic(join(caseDir, "result.json"), result);
  return result;
}

export async function runSuite({ root = process.cwd(), suiteId, configPath = ".codex/harness.yaml", runId: requestedRunId = null, commandOverride = null } = {}) {
  if (!suiteId) throw new ManifestValidationError("suite id is required");
  const id = requestedRunId || runId();
  let config;
  let runDir;
  try {
    config = await loadHarnessConfig(root, configPath);
    runDir = resolve(root, config.eval.runtime_path, id);
  } catch (error) {
    runDir = resolve(root, ".codex/evals/.runtime", id);
    await mkdir(runDir, { recursive: true });
    const result = { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: error.reason || "environment_provisioning_failure", phase: "preflight", message: error.message };
    await writeJsonAtomic(join(runDir, "result.json"), result);
    await writeJsonAtomic(join(runDir, "report.json"), result);
    return { ...result, run_dir: runDir };
  }
  let suite;
  try {
    suite = await loadSuite(root, suiteId, config);
  } catch (error) {
    await mkdir(runDir, { recursive: true });
    const result = { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: error.reason || "invalid_case_manifest", phase: "preflight", message: error.message };
    await writeJsonAtomic(join(runDir, "result.json"), result);
    await writeJsonAtomic(join(runDir, "report.json"), result);
    return { ...result, run_dir: runDir };
  }
  await mkdir(runDir, { recursive: true });
  await writeJsonAtomic(join(runDir, "config-snapshot.json"), { config_path: config.path, suite_path: suite.path, environment_profile: config.eval.default_environment_profile, baseline: suite.baseline, command_override: commandOverride });
  const caseResults = [];
  for (const caseSpec of suite.cases) {
    const result = await runCase({ root, runDir, config, caseSpec, commandOverride });
    caseResults.push(result);
    await writeJsonAtomic(join(runDir, "case-results.json"), caseResults);
  }
  const report = evaluateSuite({ suite, caseResults });
  report.run_id = id;
  report.config_snapshot = join(runDir, "config-snapshot.json");
  await persistReport(runDir, report);
  return { ...report, run_dir: runDir };
}
