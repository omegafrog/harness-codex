import { chmod, copyFile, cp, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadHarnessConfig, loadSuite, resolveFixture, resolvePortablePath } from "./case-loader.mjs";
import { CodexProcessAdapter, resolveCodexCommand } from "./codex-adapter.mjs";
import { EvalInconclusiveError, EvalPolicyViolationError, ManifestValidationError } from "./errors.mjs";
import { gradeHardGates, detectTrajectoryViolation } from "./graders/hard-gates.mjs";
import { gradeOutcome } from "./graders/outcome.mjs";
import { collectDeterministicTrajectoryMetrics, collectEfficiency, QualityGrader } from "./graders/quality.mjs";
import { JsonlEventWriter, TrajectoryWriter, projectCheckpoint, recoverEventStream, recoverTrajectoryStream, replayEventStream, replayTrajectoryStream } from "./journal.mjs";
import { createExternalSystemPort } from "./recording.mjs";
import { evaluateSuite, finalizeCase, persistReport } from "./report.mjs";
import { ensureDir, isWithin, writeJsonAtomic } from "./util.mjs";
import { assertWorkspaceTarget, provisionCaseWorkspace, cleanupCaseWorkspace } from "./case-workspace.mjs";

const execFileAsync = promisify(execFile);

function runId() {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

async function currentGitHead(root) {
  try {
    const result = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const commit = result.stdout.trim();
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function makeInconclusiveCaseResult({ runDir, caseSpec, caseDir = join(runDir, "cases", caseSpec.id), reason, phase, message, cleanup = { state: "passed", reason: null } }) {
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
    artifacts: { case_dir: caseDir, event_stream: join(caseDir, "events.jsonl"), trajectory: join(caseDir, "trajectory.jsonl"), external_events: join(caseDir, "external-events.jsonl"), recording: join(caseDir, "recording.jsonl") },
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

async function collectOutcomeArtifactEvidence(caseSpec, workspace) {
  const files = [];
  const workspaceReal = await realpath(workspace);
  for (const rule of Object.values(caseSpec.outcome_evidence || {})) {
    for (const relativePath of rule.required_files || []) {
      const path = resolve(workspace, relativePath);
      if (!isWithin(workspace, path)) continue;
      try {
        const resolvedPath = await realpath(path);
        if (!isWithin(workspaceReal, resolvedPath) || !(await stat(resolvedPath)).isFile()) continue;
        files.push(relativePath);
      } catch {
        // Missing required artifacts remain absent from evidence.
      }
    }
  }
  return { files };
}

export function resolveCodexHome({ workspace, config, environment = process.env }) {
  return join(workspace, ".eval-codex-home");
}

export async function seedCodexAuth({ workspace, config, environment = process.env }) {
  if ((config.eval?.codex?.auth_mode || "isolated") !== "inherited") return false;
  const sourceHome = environment.CODEX_HOME || (environment.HOME ? join(environment.HOME, ".codex") : null);
  if (!sourceHome) throw new EvalInconclusiveError("codex_authentication_unavailable", "No host Codex credential source is configured");
  const sourceAuth = join(sourceHome, "auth.json");
  let sourceInfo;
  try {
    sourceInfo = await lstat(sourceAuth);
  } catch (error) {
    throw new EvalInconclusiveError("codex_authentication_unavailable", `Codex credential file is unavailable: ${sourceAuth}`, { cause: error });
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new EvalInconclusiveError("codex_authentication_unavailable", `Codex credential file is not a regular file: ${sourceAuth}`);
  }
  const destination = join(resolveCodexHome({ workspace, config }), "auth.json");
  try {
    await copyFile(sourceAuth, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    throw new EvalInconclusiveError("codex_authentication_unavailable", `Unable to seed isolated Codex credentials: ${destination}`, { cause: error });
  }
  return true;
}

function caseEnvironment(caseSpec, config, workspace, runDir, external, root, caseDir, attempt) {
  const profile = config.eval.environment_profiles[caseSpec.environment_profile];
  const modelConfig = caseSpec.environment?.codex?.model_config || config.eval.codex?.model_config;
  return {
    ...(caseSpec.environment?.env || {}),
    ...(config.eval.environment?.env || {}),
    HARNESS_EVAL_CASE_ID: caseSpec.id,
    HARNESS_EVAL_CASE_ATTEMPT: String(attempt),
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
    HARNESS_EVAL_EXTERNAL_RUNTIME: join(caseDir, "recording.jsonl"),
    HARNESS_EVAL_EXTERNAL_EVENTS: join(caseDir, "external-events.jsonl"),
    HARNESS_EVAL_EXTERNAL_MUTATION: "deny",
    HARNESS_EVAL_INTEGRATION: String(caseSpec.integration),
    HARNESS_EVAL_INTEGRATION_RESOURCE: caseSpec.integration_resource ? JSON.stringify(caseSpec.integration_resource) : "",
    HARNESS_EVAL_EXTERNAL_PORT_COMMAND: JSON.stringify([process.execPath, resolve(root, "bin/harness-external-port.mjs")]),
    HARNESS_EVAL_MODEL: caseSpec.environment?.codex?.model || config.eval.codex?.model || "",
    HARNESS_EVAL_MODEL_CONFIG: modelConfig === undefined || modelConfig === null
      ? ""
      : typeof modelConfig === "string" ? modelConfig : JSON.stringify(modelConfig),
    HOME: join(workspace, ".eval-home"),
    CODEX_HOME: resolveCodexHome({ workspace, config }),
    TMPDIR: join(workspace, ".eval-tmp"),
  };
}

async function runCase({ root, runDir, config, caseSpec, commandOverride = null, qualityEvaluator = null, attempt = 1 }) {
  const caseDir = attempt === 1 ? join(runDir, "cases", caseSpec.id) : join(runDir, "cases", caseSpec.id, "attempts", String(attempt));
  await ensureDir(caseDir);
  const eventPath = join(caseDir, "events.jsonl");
  const trajectoryPath = join(caseDir, "trajectory.jsonl");
  const eventStreamId = attempt === 1 ? `case-${caseSpec.id}` : `case-${caseSpec.id}-attempt-${attempt}`;
  const trajectoryStreamId = attempt === 1 ? `trajectory-${caseSpec.id}` : `trajectory-${caseSpec.id}-attempt-${attempt}`;
  const existingEvents = await replayEventStream(eventPath, { streamId: eventStreamId });
  const existingTrajectory = await replayTrajectoryStream(trajectoryPath, { streamId: trajectoryStreamId });
  let eventRecovery = existingEvents.corruption;
  const trajectoryRecovery = existingTrajectory.corruption;
  if (existingEvents.corruption) {
    await recoverEventStream(eventPath, { streamId: eventStreamId, checkpointPath: join(caseDir, "checkpoint.md") });
  }
  const events = new JsonlEventWriter(eventPath, { streamId: eventStreamId });
  const trajectory = new TrajectoryWriter(trajectoryPath, { streamId: trajectoryStreamId });
  await events.init();
  await trajectory.init();
  const startedAt = Date.now();
  let workspaceHandle = null;
  let external = null;
  let externalClosePromise = null;
  const closeExternal = async () => {
    if (!external) return;
    externalClosePromise ||= Promise.resolve(external.close?.());
    await externalClosePromise;
  };
  let execution = { exitCode: null, processError: null, inconclusiveReason: null, timedOut: false, durationMs: 0, command: null };
  let hardGates = null;
  let outcome = { passed: false, results: {}, missing: caseSpec.required_outcome };
  let quality = null;
  let efficiency = { tokens: 0, latency_ms: 0, tool_calls: 0, turns: 0, handoffs: 0 };
  await events.append("case_started", { case_id: caseSpec.id, workflow: caseSpec.workflow }, { critical: true });
  try {
    if (trajectoryRecovery) execution.inconclusiveReason = "corrupted_trajectory";
    const fixture = resolveFixture(root, caseSpec);
    workspaceHandle = await provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath: fixture });
    await seedCodexAuth({ workspace: workspaceHandle.workspace, config });
    const recordingFixture = caseSpec.recording.mode === "replay" ? resolvePortablePath(root, caseSpec.recording.fixture) : null;
    const externalDescriptor = {
      mode: caseSpec.recording.mode,
      fixture: recordingFixture,
      integration: caseSpec.integration,
      integrationResource: caseSpec.integration_resource,
    };
    external = createExternalSystemPort({
      mode: caseSpec.recording.mode,
      fixture: recordingFixture,
      runtimePath: join(caseDir, "recording.jsonl"),
      integration: caseSpec.integration,
      integrationResource: caseSpec.integration_resource,
      subprocessCommand: [process.execPath, resolve(root, "bin/harness-external-port.mjs")],
      subprocessCwd: workspaceHandle.workspace,
      subprocessEnv: caseEnvironment(caseSpec, config, workspaceHandle.workspace, runDir, externalDescriptor, root, caseDir, attempt),
    });
    await external.init();
    const adapter = new CodexProcessAdapter();
    let failFast = false;
    const seenViolations = new Set();
    let liveHardCapExceeded = null;
    let externalInconclusiveReason = null;
    const liveEfficiency = { turns: 0, tool_calls: 0, tokens: 0 };
    const classifyExternalError = async (error, request, control) => {
      if (error instanceof EvalPolicyViolationError) {
        await events.append("hard_gate_violation", { gate: error.reason, mode: "fail_fast", action: request.operation, target: request.target, request }, { critical: true, extra: { gate: error.reason, mode: "fail_fast" } });
        failFast = true;
        control.terminate();
      } else if (error instanceof EvalInconclusiveError) {
        externalInconclusiveReason ||= error.reason;
        await events.append("external_port_error", { reason: error.reason, request }, { critical: true, extra: { reason: error.reason } });
      } else {
        externalInconclusiveReason ||= "external_provider_error";
        await events.append("external_port_error", { reason: "external_provider_error", request, message: error.message }, { critical: true, extra: { reason: "external_provider_error" } });
      }
    };
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
      if (record.target) {
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
      if (record.action === "external_request" && record.payload?.request) {
        const request = record.payload.request;
        let externalRecord;
        try {
          const response = await external.execute(request);
          externalRecord = await trajectory.append({
            actor: "external",
            kind: "tool_result",
            correlation_id: record.correlation_id,
            action: record.action,
            target: record.target ?? request.target,
            status: "success",
            payload: { response, external_operation: request.operation },
            source: "structured_event",
          });
        } catch (error) {
          externalRecord = await trajectory.append({
            actor: "external",
            kind: "tool_result",
            correlation_id: record.correlation_id,
            action: record.action,
            target: record.target ?? request.target,
            status: error.reason === "unauthorized_external_mutation" ? "denied" : "error",
            payload: { reason: error.reason || "external_provider_error" },
            source: "structured_event",
          });
          await classifyExternalError(error, request, control);
        }
      }
    };
    const command = resolveCodexCommand({ caseSpec, config, commandOverride });
    const workflowEntrypoint = `$${caseSpec.workflow}`;
    const scenarioPrompt = caseSpec.scenario?.prompt || `Execute eval case ${caseSpec.id}`;
    const prompt = scenarioPrompt.includes(workflowEntrypoint)
      ? scenarioPrompt
      : `${workflowEntrypoint}\n${scenarioPrompt}`;
    await events.append("workflow_dispatch_requested", { workflow: caseSpec.workflow, entrypoint: workflowEntrypoint }, { critical: true });
    execution = await adapter.run({
      command,
      cwd: workspaceHandle.workspace,
      env: caseEnvironment(caseSpec, config, workspaceHandle.workspace, runDir, external, root, caseDir, attempt),
      stdin: prompt,
      timeoutMs: caseSpec.hard_caps.max_latency_ms || config.eval.default_case_timeout_ms || null,
      trajectory,
      onRecord,
      onTerminate: async () => {
        try {
          await closeExternal();
        } catch (error) {
          execution.inconclusiveReason ||= error.reason || "external_provider_error";
          await events.append("external_port_error", { reason: execution.inconclusiveReason, message: error.message }, { critical: true, extra: { reason: execution.inconclusiveReason } });
        }
      },
      onEvent: async (event) => events.append(event.type, event.payload || {}, { critical: event.type === "process_started" }),
      caseId: caseSpec.id,
      workflow: caseSpec.workflow,
      permissionProfile: config.eval.environment_profiles[caseSpec.environment_profile].permission_profile,
      environmentProfile: caseSpec.environment_profile,
    });
    await closeExternal();
    const externalEventsPath = join(caseDir, "external-events.jsonl");
    const externalEvents = await replayEventStream(externalEventsPath, { streamId: `external-${caseSpec.id}` });
    if (externalEvents.corruption) throw new EvalInconclusiveError("corrupted_fixture", `External event stream is corrupt: ${externalEventsPath}`);
    for (const event of externalEvents.events) {
      if (event.type === "external_port_error") externalInconclusiveReason ||= event.payload?.reason || "missing_external_recording";
      if (event.type === "unauthorized_external_access") failFast = true;
      await events.append(event.type, event.payload, { critical: true, extra: { external_stream_id: event.stream_id, external_seq: event.seq, ...(event.payload?.reason ? { reason: event.payload.reason } : {}) } });
    }
    execution.failFast = failFast;
    execution.inconclusiveReason ||= externalInconclusiveReason;
    const trajectoryAfterExecution = await replayTrajectoryStream(trajectoryPath, { streamId: trajectoryStreamId });
    if (trajectoryAfterExecution.corruption) throw new EvalInconclusiveError("corrupted_trajectory", `Trajectory stream is corrupt: ${trajectoryPath}`);
    execution.records = trajectoryAfterExecution.events;
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
    outcome = gradeOutcome({ caseSpec, trajectory: execution.records, artifactEvidence: await collectOutcomeArtifactEvidence(caseSpec, workspaceHandle.workspace) });
    efficiency = collectEfficiency({ trajectory: execution.records, execution, startedAt, finishedAt: Date.now() });
    try {
      const evaluatorWorkspace = join(caseDir, "evaluator-workspace");
      await ensureDir(evaluatorWorkspace);
      quality = await new QualityGrader({
        model: config.eval.quality_grader?.model,
        modelConfig: config.eval.quality_grader?.model_config,
        rubricVersion: config.eval.quality_grader?.rubric_version || "1",
        command: config.eval.quality_grader?.command || config.eval.codex?.command,
        timeoutMs: config.eval.quality_grader?.timeout_ms || config.eval.default_case_timeout_ms || 120000,
        cwd: evaluatorWorkspace,
        environment: {
          HOME: workspaceHandle.isolatedHome,
          CODEX_HOME: workspaceHandle.isolatedCodexHome,
          TMPDIR: workspaceHandle.isolatedTmp,
          NO_COLOR: "1",
        },
        evaluator: qualityEvaluator,
      }).grade({
        artifactBundle: {
          schema_version: 1,
          case_spec: {
            id: caseSpec.id,
            workflow: caseSpec.workflow,
            required_outcome: caseSpec.required_outcome,
            outcome_evidence: caseSpec.outcome_evidence,
            hard_gates: caseSpec.hard_gates,
            quality_threshold: caseSpec.quality_threshold,
            scenario: caseSpec.scenario || null,
          },
          normalized_trajectory: execution.records,
          normalized_events: eventRecords,
          final_output: execution.finalOutput,
          relevant_diff: null,
          outcome_evidence: outcome,
          deterministic_trajectory_metrics: collectDeterministicTrajectoryMetrics(execution.records),
        },
      });
    } catch (error) {
      throw new EvalInconclusiveError("grader_execution_error", `Quality grader failed: ${error.message}`, { cause: error });
    }
    await writeJsonAtomic(join(caseDir, "execution.json"), { ...execution, stdout: undefined, stderr: undefined, processError: undefined });
    await writeJsonAtomic(join(caseDir, "final-output.json"), { output: execution.finalOutput });
  } catch (error) {
    try { await closeExternal(); } catch { execution.inconclusiveReason ||= "harness_runner_crash"; }
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
    if (trajectoryReplay.corruption) {
      await recoverTrajectoryStream(trajectoryPath, { streamId: trajectoryStreamId });
      execution.inconclusiveReason ||= "corrupted_trajectory";
    }
  } catch (error) {
    evidenceError ||= error;
  }
  if (evidenceError) execution.inconclusiveReason ||= "harness_runner_crash";
  if (!quality) quality = { task_quality: 0, trajectory_quality: 0, quality: 0, dimensions: {}, rationale: "평가 불가", evaluator_snapshot: null };
  hardGates = gradeHardGates({ caseSpec, trajectory: execution.records || [], events: eventRecords });
  const makeResult = () => finalizeCase({ caseSpec, executionResult: execution, cleanup, hardGates, outcome, quality, efficiency, artifacts: { case_dir: caseDir, event_stream: eventPath, trajectory: trajectoryPath, external_events: join(caseDir, "external-events.jsonl"), recording: join(caseDir, "recording.jsonl") } });
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

async function runSuiteInternal({ root = process.cwd(), suiteId, configPath = ".codex/harness.yaml", runId: requestedRunId = null, commandOverride = null, qualityEvaluator = null, attempt = 1, retryOf = null } = {}) {
  if (!suiteId) throw new ManifestValidationError("suite id is required");
  const id = requestedRunId || runId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new ManifestValidationError("run id must be a safe path identifier");
  let config;
  let runDir;
  try {
    config = await loadHarnessConfig(root, configPath);
    const runtimeRoot = resolvePortablePath(root, config.eval.runtime_path);
    if (!runtimeRoot || !isWithin(root, runtimeRoot)) throw new ManifestValidationError("eval runtime_path must remain inside repository root");
    runDir = resolve(runtimeRoot, id);
    try {
      await stat(runDir);
      return { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: "duplicate_run_id", phase: "preflight", run_dir: runDir };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } catch (error) {
    runDir = resolve(root, ".codex/evals/.runtime", id);
    await mkdir(dirname(runDir), { recursive: true });
    try {
      await mkdir(runDir);
    } catch (claimError) {
      if (claimError.code === "EEXIST") return { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: "duplicate_run_id", phase: "preflight", run_dir: runDir };
      throw claimError;
    }
    const result = { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: error.reason || "environment_provisioning_failure", phase: "preflight", message: error.message };
    await writeJsonAtomic(join(runDir, "result.json"), result);
    await writeJsonAtomic(join(runDir, "report.json"), result);
    return { ...result, run_dir: runDir };
  }
  let suite;
  try {
    suite = await loadSuite(root, suiteId, config);
  } catch (error) {
    await mkdir(dirname(runDir), { recursive: true });
    try {
      await mkdir(runDir);
    } catch (claimError) {
      if (claimError.code === "EEXIST") return { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: "duplicate_run_id", phase: "preflight", run_dir: runDir };
      throw claimError;
    }
    const result = { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: error.reason || "invalid_case_manifest", phase: "preflight", message: error.message };
    await writeJsonAtomic(join(runDir, "result.json"), result);
    await writeJsonAtomic(join(runDir, "report.json"), result);
    return { ...result, run_dir: runDir };
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > suite.retry.max_attempts) throw new ManifestValidationError(`attempt must be between 1 and suite.retry.max_attempts (${suite.retry.max_attempts})`);
  if (attempt === 1 && retryOf !== null) throw new ManifestValidationError("retry_of is only valid for retry attempts");
  if (attempt > 1 && (typeof retryOf !== "string" || !retryOf.trim())) throw new ManifestValidationError("retry attempts require retry_of");
  await mkdir(dirname(runDir), { recursive: true });
  try {
    await mkdir(runDir);
  } catch (error) {
    if (error.code === "EEXIST") return { schema_version: 1, suite_id: suiteId, run_id: id, state: "inconclusive", passed: false, reason: "duplicate_run_id", phase: "preflight", run_dir: runDir };
    throw error;
  }
  await writeJsonAtomic(join(runDir, "config-snapshot.json"), {
    schema_version: 1,
    run_id: id,
    attempt,
    retry_of: retryOf,
    harness_commit: await currentGitHead(root),
    config_path: config.path,
    suite_path: suite.path,
    model: config.eval.codex?.model || null,
    model_config: config.eval.codex?.model_config || null,
    environment_profile: config.eval.default_environment_profile,
    baseline: suite.baseline,
    retry: suite.retry,
    command_override: commandOverride,
  });
  const caseResults = [];
  for (const caseSpec of suite.cases) {
    let result;
    try {
      result = await runCase({ root, runDir, config, caseSpec, commandOverride, qualityEvaluator, attempt });
    } catch (error) {
      result = makeInconclusiveCaseResult({ runDir, caseSpec, reason: error.reason || "harness_runner_crash", phase: "case_initialization", message: error.message });
      const caseDir = attempt === 1 ? join(runDir, "cases", caseSpec.id) : join(runDir, "cases", caseSpec.id, "attempts", String(attempt));
      result = { ...result, attempt };
      await ensureDir(caseDir);
      await writeJsonAtomic(join(caseDir, "result.json"), result);
    }
    result = { ...result, attempt };
    caseResults.push(result);
    await writeJsonAtomic(join(runDir, "case-results.json"), caseResults);
  }
  const report = evaluateSuite({ suite, caseResults, attempt, retryOf });
  report.run_id = id;
  report.config_snapshot = join(runDir, "config-snapshot.json");
  await persistReport(runDir, report);
  return { ...report, run_dir: runDir };
}

export async function runSuite(options = {}) {
  if (options.commandOverride) throw new ManifestValidationError("commandOverride is test-only; use the configured Codex CLI");
  return runSuiteInternal(options);
}

export function runSuiteForTest(options = {}) {
  return runSuiteInternal({
    ...options,
    qualityEvaluator: options.qualityEvaluator || (async () => ({
      task_quality: 1,
      trajectory_quality: 1,
      dimensions: { test_evaluator: 1 },
      rationale: "test evaluator",
    })),
  });
}
