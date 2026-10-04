import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { collectRuntimeEvidence } from "../knowledge/runtime-evidence.mjs";

const RETRY_METRICS = new Set(["case_result_state", "quality", "tokens", "latency_ms", "tool_calls", "turns", "handoffs", "required_outcome_passed", "hard_gates_passed"]);

function validateRetryCandidate(candidate) {
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const safeText = (value) => typeof value === "string" && value.trim() && value.length <= 256 && !/[\r\n\0]/.test(value);
  const observationKeys = ["origin_project", "run_id", "event_id", "timestamp", "environment", "type", "execution_status", "measurement_validity", "observations", "summary"];
  if (!exactKeys(candidate, ["schema_version", "definition", "observation"]) || candidate.schema_version !== 1) return false;
  if (!exactKeys(candidate.definition, ["execution_purpose"]) && !exactKeys(candidate.definition, ["execution_purpose", "decision_ids"])) return false;
  if (!["code_validation", "decision_validation"].includes(candidate.definition.execution_purpose)) return false;
  const observation = candidate.observation;
  if (!exactKeys(observation, observationKeys) || observation.origin_project !== "harness-codex" || !safeText(observation.run_id) || !safeText(observation.event_id)) return false;
  if (!Number.isFinite(Date.parse(observation.timestamp)) || observation.type !== "failure_test") return false;
  if (!exactKeys(observation.environment, ["runtime", "platform"]) || !safeText(observation.environment.runtime) || !safeText(observation.environment.platform)) return false;
  if (!["completed", "failed", "interrupted"].includes(observation.execution_status) || !["valid", "invalid"].includes(observation.measurement_validity)) return false;
  if (!Array.isArray(observation.observations) || observation.observations.length === 0 || !safeText(observation.summary)) return false;
  return observation.observations.every((item) => exactKeys(item, ["metric", "value", "unit"])
    && RETRY_METRICS.has(item.metric)
    && (typeof item.value === "number" ? Number.isFinite(item.value) : safeText(item.value))
    && safeText(item.unit));
}

function measurements(caseResult) {
  const result = [];
  const addNumber = (metric, value, unit) => {
    if (typeof value === "number" && Number.isFinite(value)) result.push({ metric, value, unit });
  };
  const addBoolean = (metric, value) => {
    if (typeof value === "boolean") result.push({ metric, value: value ? 1 : 0, unit: "boolean" });
  };
  result.push({ metric: "case_result_state", value: caseResult?.state || "unknown", unit: "state" });
  addNumber("quality", caseResult?.quality?.quality, "score");
  addNumber("tokens", caseResult?.efficiency?.tokens, "tokens");
  addNumber("latency_ms", caseResult?.efficiency?.latency_ms, "ms");
  addNumber("tool_calls", caseResult?.efficiency?.tool_calls, "calls");
  addNumber("turns", caseResult?.efficiency?.turns, "turns");
  addNumber("handoffs", caseResult?.efficiency?.handoffs, "handoffs");
  addBoolean("required_outcome_passed", caseResult?.required_outcome?.passed);
  addBoolean("hard_gates_passed", caseResult?.hard_gates?.passed);
  return result;
}

async function persistRetry({ root, retryArtifactPath, definition, observation }) {
  if (!retryArtifactPath) return null;
  const path = resolve(retryArtifactPath);
  const rel = relative(resolve(root), path);
  if (!rel.startsWith(".codex/evals/.runtime/")) throw new TypeError("Runtime Evidence retry artifacts must stay under .codex/evals/.runtime.");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schema_version: 1, definition, observation }, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return path;
}

/** Collect normalized Harness execution results without affecting the case verdict. */
export async function observeHarnessExecution({ root = process.cwd(), definition, runId, caseId, caseResult, observedAt = null, retryArtifactPath = null }) {
  const state = caseResult?.state;
  const executionStatus = state === "passed" ? "completed" : state === "failed" ? "failed" : "interrupted";
  const observation = {
    origin_project: "harness-codex",
    run_id: runId,
    event_id: caseId,
    timestamp: observedAt || caseResult?.timestamp || new Date().toISOString(),
    environment: { runtime: `node ${process.versions.node}`, platform: process.platform },
    type: "failure_test",
    execution_status: executionStatus,
    measurement_validity: state === "passed" ? "valid" : "invalid",
    observations: measurements(caseResult),
    summary: `Harness case ${caseId} finished with state ${state || "unknown"}.`,
  };
  const result = await collectRuntimeEvidence({ root, definition, observation });
  if (result.diagnostic?.code !== "evidence_write_failed") return result;
  try {
    const retryPath = await persistRetry({ root, retryArtifactPath, definition, observation });
    return { ...result, retryable: Boolean(retryPath), ...(retryPath ? { retry_artifact: retryPath } : {}) };
  } catch (error) {
    return { ...result, retryable: false, retry_persistence_diagnostic: error.message };
  }
}

/** Retry only local Evidence staging from the normalized candidate saved after a write failure. */
export async function retryRuntimeEvidence({ root = process.cwd(), retryArtifactPath }) {
  if (!retryArtifactPath) throw new TypeError("retryArtifactPath is required.");
  const path = resolve(retryArtifactPath);
  const candidate = JSON.parse(await readFile(path, "utf8"));
  if (!validateRetryCandidate(candidate)) {
    return { collected: false, diagnostic: { code: "invalid_runtime_retry_artifact", message: "Runtime Evidence retry artifact is malformed." } };
  }
  const result = await collectRuntimeEvidence({ root, definition: candidate.definition, observation: candidate.observation });
  if (result.collected) await rm(path, { force: true });
  return result;
}
