import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadHarnessConfig, loadSuite, resolveFixture } from "./case-loader.mjs";
import { CodexProcessAdapter, resolveCodexCommand } from "./codex-adapter.mjs";
import { EvalInconclusiveError, EvalPolicyViolationError, ManifestValidationError } from "./errors.mjs";
import { gradeHardGates, detectTrajectoryViolation } from "./graders/hard-gates.mjs";
import { gradeOutcome } from "./graders/outcome.mjs";
import { collectEfficiency, QualityGrader } from "./graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter, projectCheckpoint, recoverEventStream, recoverTrajectoryStream, replayEventStream, replayTrajectoryStream } from "./journal.mjs";
import { ExternalSystemPort } from "./recording.mjs";
import { evaluateSuite, finalizeCase, persistReport } from "./report.mjs";
import { ensureDir, isWithin, writeJsonAtomic } from "./util.mjs";
import { assertWorkspaceTarget, provisionCaseWorkspace, cleanupCaseWorkspace } from "./case-workspace.mjs";

function runId() {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
}

function makeInconclusiveCaseResult({ runDir, caseSpec, reason, phase, message, cleanup = { state: "passed", reason: null } }) {
  return {
    schema_version: 1,
    case_id: caseSpec.id,
    workflow: caseSpec.workflow,
    critical: caseSpec.critical,
    state: "inconclusive",
    reason,
    passed: false,
    phase,
    execution_result: { state: "inconclusive", exit_code: null, signal: null, duration_ms: null, command: null },
    cleanup,
    hard_gates: { passed: true, violations: [] },
    required_outcome: { passed: false, results: {}, missing: caseSpec.required_outcome },
    quality: { task_quality: 0, trajectory_quality: 0, quality: 0, dimensions: {}, rationale: "평가 불가", evaluator_snapshot: null },
    efficiency: { tokens: 0, latency_ms: 0, tool_calls: 0, turns: 0, handoffs: 0 },
    artifacts: { case_dir: join(runDir, "cases", caseSpec.id), event_stream: join(runDir, "cases", caseSpec.id, "events.jsonl"), trajectory: join(runDir, "cases", caseSpec.id, "trajectory.jsonl"), recording: join(runDir, "cases", caseSpec.id, "recording.jsonl") },
    ...(message ? { message } : {}),
  };
}

async function copyFixture(fixture, caseDir) {
  if (!fixture) return null;
  const destination = join(caseDir, "fixture");
  await cp(fixture, destination, { recursive: true, force: false, errorOnExist: false });
  return destination;
}

function hardCapStatus(caseSpec, { turns = 0, tool_calls: toolCalls = 0, tokens = 0 } = {}) {
  const caps = caseSpec.hard_caps;
  if (caps.max_turns && turns > caps.max_turns) return { cap: "max_turns", actual: turns, limit: caps.max_turns };
  if (caps.max_tool_calls && toolCalls > caps.max_tool_calls) return { cap: "max_tool_calls", actual: toolCalls, limit: caps.max_tool_calls };
  if (caps.max_tokens && tokens > caps.max_tokens) return { cap: "max_tokens", actual: tokens, limit: caps.max_tokens };
  return null;
}

function caseEnvironment(caseSpec, config, workspace, runDir, external, root) {
  const profile = config.eval.environment_profiles[caseSpec.environment_profile];
  const modelConfig = caseSpec.environment?.codex?.model_config || config.eval.codex?.model_config;
  return {
    ...(caseSpec.environment?.env || {}),
    ...(config.eval.environment?.env || {}),
    HARNESS_EVAL_CASE_ID: caseSpec.id,
    HARNESS_EVAL_WORKSPACE: workspace,
    HARNESS_EVAL_RUN_DIR: runDir,
    HARNESS_EVAL_ENVIRONMENT_PROFILE: caseSpec.environment_profile,
    HARNESS_EVAL_CASE_MANIFEST: caseSpec.path,
    HARNESS_EVAL_WORKFLOW: caseSpec.workflow,
    HARNESS_EVAL_PERMISSION_PROFILE: profile.permission_profile,
    HARNESS_EVAL_NATIVE_SANDBOX: profile.sandbox || "",
    HARNESS_EVAL_NETWORK_POLICY: profile.network,
    HARNESS_EVAL_EXTERNAL_PORT_MODE: external.mode,
    HARNESS_EVAL_EXTERNAL_RECORDING: external.fixture || "",
    HARNESS_EVAL_EXTERNAL_MUTATION: "deny",
    HARNESS_EVAL_INTEGRATION: String(caseSpec.integration),
    HARNESS_EVAL_INTEGRATION_RESOURCE: caseSpec.integration_resource ? JSON.stringify(caseSpec.integration_resource) : "",
    HARNESS_EVAL_EXTERNAL_PORT_COMMAND: JSON.stringify([process.execPath, resolve(root, "bin/harness-external-port.mjs")]),
    HARNESS_EVAL_MODEL: caseSpec.environment?.codex?.model || config.eval.codex?.model || "",
    HARNESS_EVAL_MODEL_CONFIG: modelConfig === undefined || modelConfig === null
      ? ""
      : typeof modelConfig === "string" ? modelConfig : JSON.stringify(modelConfig),
    HOME: join(workspace, ".eval-home"),
    CODEX_HOME: join(workspace, ".eval-codex-home"),
    TMPDIR: join(workspace, ".eval-tmp"),
  };
}

async function runCase({ root, runDir, config, caseSpec, commandOverride = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  await ensureDir(caseDir);
  const eventPath = join(caseDir, "events.jsonl");
  const trajectoryPath = join(caseDir, "trajectory.jsonl");
  const eventStreamId = `case-${caseSpec.id}`;
  const trajectoryStreamId = `trajectory-${caseSpec.id}`;
  const existingEvents = await replayEventStream(eventPath, { streamId: eventStreamId });
  let eventRecovery = existingEvents.corruption;
  if (existingEvents.corruption) {
    await recoverEventStream(eventPath, { streamId: eventStreamId, checkpointPath: join(caseDir, "checkpoint.md") });
  }
  const events = new JsonlEventWriter(eventPath, { streamId: eventStreamId });
  const trajectory = new TrajectoryWriter(trajectoryPath, { streamId: trajectoryStreamId });
  await events.init();
  await trajectory.init();
  const startedAt = Date.now();
  let workspaceHandle = null;
  let execution = { exitCode: null, processError: null, inconclusiveReason: null, timedOut: false, durationMs: 0, command: null };
  let hardGates = null;
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
      integrationResource: caseSpec.integration_resource,
      onEvent: async (event) => events.append(event.type, event.payload || {}, { critical: true }),
    }).init();
    const adapter = new CodexProcessAdapter();
    let failFast = false;
    const seenViolations = new Set();
    let liveHardCapExceeded = null;
    const liveEfficiency = { turns: 0, tool_calls: 0, tokens: 0 };
    const onRecord = async (record, control) => {
      if (record.kind === "tool_call") liveEfficiency.tool_calls += 1;
      if (record.kind === "message" && record.actor === "codex") liveEfficiency.turns += 1;
      liveEfficiency.tokens += Number(record.payload?.tokens || 0);
      if (!liveHardCapExceeded) {
        liveHardCapExceeded = hardCapStatus(caseSpec, liveEfficiency);
        if (liveHardCapExceeded) {
          await events.append("case_hard_cap_exceeded", { ...liveHardCapExceeded, mode: "fail_fast" }, { critical: true });
          control.terminate();
        }
      }
      if (liveHardCapExceeded) return;
      if (["read_file", "write_file", "delete_file", "git_push", "write", "delete"].includes(record.action)) {
        try {
          await assertWorkspaceTarget(workspaceHandle.workspace, record.target);
        } catch (error) {
          await events.append("hard_gate_violation", { gate: "workspace_escape", mode: "fail_fast", action: record.action, target: record.target }, { critical: true, extra: { gate: "workspace_escape", mode: "fail_fast" } });
          failFast = true;
          control.terminate();
          return;
        }
      }
      if (record.status === "denied") {
        await events.append("native_permission_denied", { action: record.action, target: record.target, actor: record.actor }, { critical: true });
      }
      const violation = detectTrajectoryViolation(record, caseSpec, workspaceHandle.workspace);
      if (violation) {
        const violationKey = JSON.stringify([violation.gate, violation.action, violation.target]);
        if (seenViolations.has(violationKey)) return;
        seenViolations.add(violationKey);
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
      env: caseEnvironment(caseSpec, config, workspaceHandle.workspace, runDir, external, root),
      stdin: prompt,
      timeoutMs: caseSpec.hard_caps.max_latency_ms || config.eval.default_case_timeout_ms || null,
      trajectory,
      onRecord,
      onEvent: async (event) => events.append(event.type, event.payload || {}, { critical: event.type === "process_started" }),
      caseId: caseSpec.id,
      externalPort: external,
      permissionProfile: config.eval.environment_profiles[caseSpec.environment_profile].permission_profile,
      environmentProfile: caseSpec.environment_profile,
    });
    execution.failFast = failFast;
    execution.hardCapExceeded = liveHardCapExceeded || hardCapStatus(caseSpec, {
      turns: execution.records.filter((record) => record.kind === "message" && record.actor === "codex").length,
      tool_calls: execution.records.filter((record) => record.kind === "tool_call").length,
      tokens: Number(execution.tokens ?? execution.records.reduce((sum, record) => sum + Number(record.payload?.tokens || 0), 0)),
    });
    if (execution.processError) execution.inconclusiveReason = "codex_process_crash_unattributable_to_case";
    const eventReplay = await replayEventStream(eventPath, { streamId: eventStreamId });
    if (eventReplay.corruption) eventRecovery = eventReplay.corruption;
    const eventRecords = eventReplay.events;
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
    else if (error instanceof EvalPolicyViolationError) {
      await events.append("hard_gate_violation", { gate: error.reason, mode: "fail_fast" }, { critical: true, extra: { gate: error.reason, mode: "fail_fast" } });
      execution.inconclusiveReason = null;
    } else if (error instanceof EvalInconclusiveError) execution.inconclusiveReason = error.reason;
    else execution.inconclusiveReason = "harness_runner_crash";
    await events.append("case_error", { reason: execution.inconclusiveReason, message: error.message }, { critical: true });
    efficiency = collectEfficiency({ trajectory: [], execution, startedAt, finishedAt: Date.now() });
  }
  let evidenceError = null;
  try {
    await trajectory.close();
    await events.append("evidence_flushed", { case_id: caseSpec.id }, { critical: true });
  } catch (error) {
    evidenceError = error;
  } finally {
    try { await trajectory.close(); } catch (error) { evidenceError ||= error; }
    try { await events.close(); } catch (error) { evidenceError ||= error; }
  }
  const cleanup = workspaceHandle ? await cleanupCaseWorkspace(workspaceHandle, { evidencePersisted: !evidenceError }) : { state: "passed", reason: null };
  let eventRecords = [];
  try {
    const replay = await replayEventStream(eventPath, { streamId: eventStreamId });
    if (replay.corruption) {
      eventRecovery = replay.corruption;
      eventRecords = (await recoverEventStream(eventPath, { streamId: eventStreamId, checkpointPath: join(caseDir, "checkpoint.md") })).events;
    } else {
      eventRecords = replay.events;
    }
    const trajectoryReplay = await replayTrajectoryStream(trajectoryPath, { streamId: trajectoryStreamId });
    if (trajectoryReplay.corruption) await recoverTrajectoryStream(trajectoryPath, { streamId: trajectoryStreamId });
  } catch (error) {
    evidenceError ||= error;
  }
  if (evidenceError) execution.inconclusiveReason ||= "harness_runner_crash";
  if (!quality) quality = { task_quality: 0, trajectory_quality: 0, quality: 0, dimensions: {}, rationale: "평가 불가", evaluator_snapshot: null };
  hardGates = gradeHardGates({ caseSpec, trajectory: execution.records || [], events: eventRecords });
  const makeResult = () => finalizeCase({ caseSpec, executionResult: execution, cleanup, hardGates, outcome, quality, efficiency, artifacts: { case_dir: caseDir, event_stream: eventPath, trajectory: trajectoryPath, recording: join(caseDir, "recording.jsonl") } });
  let finalResult = makeResult();
  let finalEventWritten = false;
  const appendFinalEvent = async (result) => {
    const finalEvents = await new JsonlEventWriter(eventPath, { streamId: eventStreamId }).init();
    try {
      await finalEvents.append("case_finalized", { case_id: caseSpec.id, state: result.state, reason: result.reason, passed: result.passed }, { critical: true });
    } finally {
      await finalEvents.close();
    }
  };
  try { await appendFinalEvent(finalResult); finalEventWritten = true; } catch {
    execution.inconclusiveReason ||= "harness_runner_crash";
    finalResult = makeResult();
    try { await appendFinalEvent(finalResult); finalEventWritten = true; } catch { /* Preserve the result even when the journal itself is unavailable. */ }
  }
  if (finalEventWritten) {
    try {
      const finalReplay = await replayEventStream(eventPath, { streamId: eventStreamId });
      if (finalReplay.corruption) throw new Error(`Event stream corruption: ${finalReplay.corruption.kind}`);
      await projectCheckpoint(finalReplay.events, join(caseDir, "checkpoint.md"), { streamId: eventStreamId, corruption: eventRecovery });
    } catch (error) {
      execution.inconclusiveReason ||= "harness_runner_crash";
      try {
        await writeJsonAtomic(join(caseDir, "checkpoint-error.json"), { reason: "checkpoint_projection_failure", message: error.message });
      } catch {
        // Preserve the inconclusive result even when the diagnostic artifact cannot be written.
      }
      finalResult = makeResult();
      try {
        const failureEvents = await new JsonlEventWriter(eventPath, { streamId: eventStreamId }).init();
        try {
          await failureEvents.append("checkpoint_projection_failure", { message: error.message }, { critical: true });
        } finally {
          await failureEvents.close();
        }
        await appendFinalEvent(finalResult);
      } catch {
        // The result remains inconclusive even if the journal cannot record the transition.
      }
    }
  }
  finalResult = execution.inconclusiveReason && finalResult.state !== "inconclusive" ? makeResult() : finalResult;
  await writeJsonAtomic(join(caseDir, "result.json"), finalResult);
  return finalResult;
}

export async function runSuite({ root = process.cwd(), suiteId, configPath = ".codex/harness.yaml", runId: requestedRunId = null, commandOverride = null } = {}) {
  if (!suiteId) throw new ManifestValidationError("suite id is required");
  const id = requestedRunId || runId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new ManifestValidationError("run id must be a safe path identifier");
  let config;
  let runDir;
  try {
    config = await loadHarnessConfig(root, configPath);
    const runtimeRoot = resolve(root, config.eval.runtime_path);
    if (!isWithin(root, runtimeRoot)) throw new ManifestValidationError("eval runtime_path must remain inside repository root");
    runDir = resolve(runtimeRoot, id);
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
    let result;
    try {
      result = await runCase({ root, runDir, config, caseSpec, commandOverride });
    } catch (error) {
      result = makeInconclusiveCaseResult({ runDir, caseSpec, reason: error.reason || "harness_runner_crash", phase: "case_initialization", message: error.message });
      await ensureDir(join(runDir, "cases", caseSpec.id));
      await writeJsonAtomic(join(runDir, "cases", caseSpec.id, "result.json"), result);
    }
    caseResults.push(result);
    await writeJsonAtomic(join(runDir, "case-results.json"), caseResults);
  }
  const report = evaluateSuite({ suite, caseResults });
  report.run_id = id;
  report.config_snapshot = join(runDir, "config-snapshot.json");
  await persistReport(runDir, report);
  return { ...report, run_dir: runDir };
}
