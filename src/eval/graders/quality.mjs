import { spawn } from "node:child_process";

import { redact } from "../util.mjs";

export const QUALITY_WEIGHTS = Object.freeze({ task_quality: 0.65, trajectory_quality: 0.35 });
export const QUALITY_RUBRIC = `
Evaluate the semantic quality of the completed task and its trajectory.
Return JSON only with this shape:
{
  "task_quality": number,
  "trajectory_quality": number,
  "dimensions": object with numeric scores from 0 to 1,
  "rationale": string
}

task_quality: requirement coverage, correctness, ambiguity resolution, and usefulness of the result.
trajectory_quality: relevance, coherence, and proportionality of the actions taken.
Judge the supplied artifact bundle only. Do not infer hidden workspace state.
Scores must be between 0 and 1. Do not include markdown or extra keys.
`;

const DEFAULT_EVALUATOR_COMMAND = Object.freeze(["codex", "exec", "--json", "--ephemeral", "--ignore-user-config"]);
const EVALUATOR_ENVIRONMENT_KEYS = Object.freeze(["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]);

function countAction(trajectory, action) {
  return trajectory.filter((record) => record.action === action || record.payload?.action === action).length;
}

function actionEvidenceKey(record) {
  const target = record.target !== undefined
    ? record.target
    : record.payload?.command !== undefined
      ? record.payload.command
      : record.payload?.action !== undefined
        ? record.payload.action
        : "";
  return `${record.action}:${JSON.stringify(target)}`;
}

/** Deterministic operational metrics. Never substitutes for semantic quality. */
export class DeterministicTrajectoryMetrics {
  collect(trajectory = []) {
    const actionEvidence = trajectory.filter((record) => record.action && record.kind === "tool_call");
    return {
      duplicate_actions: actionEvidence.length - new Set(actionEvidence.map(actionEvidenceKey)).size,
      backtracking: countAction(trajectory, "stage_backtrack") + countAction(trajectory, "retry"),
      tool_calls: trajectory.filter((record) => record.kind === "tool_call").length,
    };
  }
}

export function collectDeterministicTrajectoryMetrics(trajectory = []) {
  return new DeterministicTrajectoryMetrics().collect(trajectory);
}

export class QualityGraderError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "QualityGraderError";
    this.reason = "grader_execution_error";
  }
}

function assertArtifactBundle(artifactBundle) {
  if (!artifactBundle || typeof artifactBundle !== "object" || Array.isArray(artifactBundle)) {
    throw new QualityGraderError("QualityGrader requires a versioned artifact bundle");
  }
  if (artifactBundle.schema_version !== 1 || !artifactBundle.case_spec || typeof artifactBundle.case_spec !== "object" || !Array.isArray(artifactBundle.normalized_trajectory)) {
    throw new QualityGraderError("QualityGrader requires a versioned artifact bundle");
  }
}

function clampScore(value, label) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new QualityGraderError(`Evaluator returned invalid ${label}`);
  return Number(score.toFixed(4));
}

function normalizeEvaluatorResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QualityGraderError("Evaluator returned a non-object result");
  if (!value.rationale || typeof value.rationale !== "string") throw new QualityGraderError("Evaluator returned no rationale");
  const dimensions = value.dimensions === undefined ? {} : value.dimensions;
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) throw new QualityGraderError("Evaluator returned invalid dimensions");
  for (const [key, score] of Object.entries(dimensions)) clampScore(score, `dimension ${key}`);
  return {
    task_quality: clampScore(value.task_quality, "task_quality"),
    trajectory_quality: clampScore(value.trajectory_quality, "trajectory_quality"),
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, score]) => [key, clampScore(score, `dimension ${key}`)])),
    rationale: value.rationale.trim(),
  };
}

function candidateTexts(value) {
  const texts = [];
  const visit = (current) => {
    if (typeof current === "string") texts.push(current);
    else if (Array.isArray(current)) current.forEach(visit);
    else if (current && typeof current === "object") Object.values(current).forEach(visit);
  };
  visit(value);
  return texts;
}

export function parseEvaluatorOutput(output) {
  const textOutput = String(output || "").trim();
  const candidates = [textOutput, ...textOutput.split(/\r?\n/).filter(Boolean)];
  for (const text of [...candidates]) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) candidates.push(fenced[1].trim());
    try { candidates.push(...candidateTexts(JSON.parse(text))); } catch { /* Try structured output text below. */ }
  }
  for (const candidate of candidates.flatMap((value) => [value, ...candidateTexts(value)])) {
    const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    for (const body of [candidate, fenced?.[1]]) {
      if (!body) continue;
      try {
        const parsed = JSON.parse(body.trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.task_quality !== undefined) return parsed;
      } catch { /* Continue scanning output. */ }
    }
  }
  throw new QualityGraderError("Evaluator returned invalid structured output");
}

export function buildQualityEvaluatorCommand(command, model) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new QualityGraderError("Quality evaluator command is invalid");
  }
  const resolved = [];
  const executable = command[0].split(/[\\/]/).at(-1)?.toLowerCase();
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === "--sandbox") {
      index += 1;
      continue;
    }
    if (command[index].startsWith("--sandbox=")) continue;
    resolved.push(command[index]);
  }
  if (executable === "codex" || executable === "codex.exe") resolved.push("--sandbox", "read-only");
  if (!resolved.some((part) => part === "--model" || part.startsWith("--model="))) resolved.push("--model", model);
  if (executable === "codex" || executable === "codex.exe") resolved.push("--config", "sandbox_workspace_write.network_access=false");
  return resolved;
}

function runEvaluatorProcess({ command, model, prompt, timeoutMs, environment, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: Object.fromEntries(EVALUATOR_ENVIRONMENT_KEYS
        .map((key) => [key, environment[key] ?? process.env[key]])
        .filter(([, value]) => value !== undefined)),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, new QualityGraderError(`Quality evaluator failed for ${model}: ${error.message}`, { cause: error })));
    child.once("close", (code, signal) => {
      if (code !== 0) finish(reject, new QualityGraderError(`Quality evaluator exited with ${code ?? signal}: ${redact(stderr || stdout).slice(0, 1000)}`));
      else finish(resolve, stdout);
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(reject, new QualityGraderError(`Quality evaluator timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdin.end(prompt);
  });
}

export class QualityGrader {
  constructor({
    model,
    modelConfig = null,
    rubricVersion = "1",
    rubric = QUALITY_RUBRIC,
    command = DEFAULT_EVALUATOR_COMMAND,
    timeoutMs = 120000,
    environment = {},
    cwd = process.cwd(),
    evaluator = null,
  } = {}) {
    if (!model || model === "deterministic-v1") throw new TypeError("QualityGrader requires a fixed evaluator model");
    this.model = model;
    this.modelConfig = modelConfig;
    this.rubricVersion = rubricVersion;
    this.rubric = rubric;
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.environment = environment;
    this.cwd = cwd;
    this.evaluator = evaluator;
  }

  async grade({ artifactBundle } = {}) {
    assertArtifactBundle(artifactBundle);
    let rawResult;
    try {
      rawResult = this.evaluator
        ? await this.evaluator({ artifactBundle, rubric: this.rubric, model: this.model, modelConfig: this.modelConfig })
        : parseEvaluatorOutput(await runEvaluatorProcess({
          command: buildQualityEvaluatorCommand(this.command, this.model),
          model: this.model,
          prompt: `${this.rubric.trim()}\n\nArtifact bundle (JSON):\n${JSON.stringify(redact(artifactBundle))}\n`,
          timeoutMs: this.timeoutMs,
          environment: this.environment,
          cwd: this.cwd,
        }));
    } catch (error) {
      if (error instanceof QualityGraderError) throw error;
      throw new QualityGraderError(`Quality evaluator execution failed: ${error.message}`, { cause: error });
    }
    const result = normalizeEvaluatorResult(rawResult);
    const quality = QUALITY_WEIGHTS.task_quality * result.task_quality + QUALITY_WEIGHTS.trajectory_quality * result.trajectory_quality;
    return {
      ...result,
      quality: Number(quality.toFixed(4)),
      evaluator_snapshot: {
        model: this.model,
        ...(this.modelConfig === null || this.modelConfig === undefined ? {} : { model_config: this.modelConfig }),
        rubric_version: this.rubricVersion,
      },
    };
  }
}

export function collectEfficiency({ trajectory = [], execution = {}, startedAt = null, finishedAt = null }) {
  const toolCalls = trajectory.filter((record) => record.kind === "tool_call").length;
  const turns = trajectory.filter((record) => record.kind === "message" && record.actor === "codex").length;
  const handoffs = trajectory.filter((record) => record.action === "handoff").length;
  const tokens = Number(execution.tokens ?? trajectory.reduce((sum, record) => sum + Number(record.payload?.tokens || 0), 0));
  return {
    tokens,
    latency_ms: Number(execution.durationMs ?? (startedAt && finishedAt ? finishedAt - startedAt : 0)),
    tool_calls: toolCalls,
    turns,
    handoffs,
  };
}
