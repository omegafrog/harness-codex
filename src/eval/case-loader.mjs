import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HARD_GATE_IDS, REQUIRED_OUTCOME_IDS } from "./contracts.mjs";
import { ManifestValidationError } from "./errors.mjs";
import { parseYaml } from "./yaml.mjs";
import { isWithin } from "./util.mjs";

const DEFAULT_EVAL_CONFIG = {
  suite_paths: "evals/suites",
  case_paths: "evals/cases",
  runtime_path: ".codex/evals/.runtime",
  default_environment_profile: "p0-default",
  default_recording_mode: "replay",
  codex: { command: ["codex", "exec", "--json"] },
  thresholds: {
    hard_gate_failures: 0,
    critical_case_pass_rate: 1,
    pass_rate: 0.95,
    mean_quality: 0.8,
    p10_quality: 0.65,
    overall: 0.75,
    max_token_regression: 0.2,
    max_latency_regression: 0.25,
    max_inconclusive_rate: 0.05,
    minimum_conclusive_cases: 0.95,
  },
};

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestValidationError(`${label} must be an object`);
  return value;
}

function asNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ManifestValidationError(`${label} must be a non-empty string`);
  return value;
}

function asIdList(value, label, registry) {
  if (!Array.isArray(value) || value.length === 0) throw new ManifestValidationError(`${label} must be a non-empty list`);
  for (const item of value) {
    if (typeof item !== "string" || !registry.has(item)) throw new ManifestValidationError(`Unknown ${label} id: ${item}`);
  }
  return value;
}

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(base[key] || {}, value) : value;
  return result;
}

export async function loadHarnessConfig(root, configPath = ".codex/harness.yaml") {
  const path = resolve(root, configPath);
  const document = parseYaml(await readFile(path, "utf8"));
  const tracker = asObject(document.tracker, "tracker");
  const github = tracker.mode === "github" ? asObject(tracker.github, "tracker.github") : null;
  const evalConfig = merge(DEFAULT_EVAL_CONFIG, document.eval || {});
  return { root, path, document, tracker: { ...tracker, ...(github ? { github } : {}) }, eval: evalConfig };
}

function validateRecording(recording) {
  const value = recording || { mode: "none" };
  asObject(value, "recording");
  if (!["replay", "none", "live"].includes(value.mode)) throw new ManifestValidationError(`Invalid recording.mode: ${value.mode}`);
  if (value.mode === "replay") asNonEmptyString(value.fixture, "recording.fixture");
  return value;
}

export function validateCaseManifest(raw, source = "case") {
  const document = asObject(raw, source);
  if (document.schema_version !== 1) throw new ManifestValidationError(`${source}.schema_version must be 1`);
  const id = asNonEmptyString(document.id, `${source}.id`);
  const workflow = asNonEmptyString(document.workflow, `${source}.workflow`);
  const requiredOutcome = asIdList(document.required_outcome, `${source}.required_outcome`, REQUIRED_OUTCOME_IDS);
  const hardGates = asIdList(document.hard_gates, `${source}.hard_gates`, HARD_GATE_IDS);
  const qualityThreshold = Number(document.quality_threshold);
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 1) throw new ManifestValidationError(`${source}.quality_threshold must be between 0 and 1`);
  const hardCaps = asObject(document.hard_caps, `${source}.hard_caps`);
  for (const key of ["max_turns", "max_tool_calls", "max_tokens"]) {
    if (hardCaps[key] !== undefined && (!Number.isInteger(hardCaps[key]) || hardCaps[key] <= 0)) throw new ManifestValidationError(`${source}.hard_caps.${key} must be a positive integer`);
  }
  const recording = validateRecording(document.recording);
  const integration = document.integration === true;
  if (recording.mode === "live" && !integration) throw new ManifestValidationError(`${source}.live recording requires integration: true`);
  if (!integration && recording.mode === "live") throw new ManifestValidationError(`${source} cannot use live integration`);
  return {
    ...document,
    schema_version: 1,
    id,
    workflow,
    critical: document.critical === true,
    required_outcome: requiredOutcome,
    hard_gates: hardGates,
    quality_threshold: qualityThreshold,
    hard_caps: hardCaps,
    integration,
    recording,
    environment_profile: document.environment_profile || "p0-default",
    forbidden_actions: Array.isArray(document.forbidden_actions) ? document.forbidden_actions : [],
  };
}

export async function loadCase(root, caseId, config, explicitPath = null) {
  const path = explicitPath ? resolve(root, explicitPath) : resolve(root, config.eval.case_paths, `${caseId}.yaml`);
  try {
    const caseSpec = { ...validateCaseManifest(parseYaml(await readFile(path, "utf8")), path), path };
    if (caseSpec.fixture) {
      const fixture = resolve(root, caseSpec.fixture);
      if (!isWithin(root, fixture)) throw new ManifestValidationError(`Fixture escapes repository root: ${caseSpec.fixture}`);
      await access(fixture);
    }
    if (caseSpec.recording.mode === "replay") await access(resolve(root, caseSpec.recording.fixture));
    return caseSpec;
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError(`Unable to load case ${caseId}: ${error.message}`, { cause: error });
  }
}

function validateBaseline(baseline) {
  const value = asObject(baseline, "suite.baseline");
  for (const key of ["id", "harness_version", "model", "model_config", "environment_profile"]) asNonEmptyString(value[key], `suite.baseline.${key}`);
  if (value.metrics !== undefined && value.metrics !== null) asObject(value.metrics, "suite.baseline.metrics");
  return value;
}

export async function loadSuite(root, suiteId, config) {
  const path = resolve(root, config.eval.suite_paths, `${suiteId}.yaml`);
  let raw;
  try {
    raw = parseYaml(await readFile(path, "utf8"));
  } catch (error) {
    throw new ManifestValidationError(`Unable to load suite ${suiteId}: ${error.message}`, { cause: error });
  }
  const document = asObject(raw, path);
  if (document.schema_version !== 1) throw new ManifestValidationError(`${path}.schema_version must be 1`);
  if (document.id !== suiteId) throw new ManifestValidationError(`Suite id mismatch: expected ${suiteId}, got ${document.id}`);
  if (!Array.isArray(document.cases) || document.cases.length === 0) throw new ManifestValidationError(`${path}.cases must be a non-empty list`);
  const cases = [];
  for (const entry of document.cases) {
    const id = typeof entry === "string" ? entry : entry?.id;
    asNonEmptyString(id, `${path}.cases[]`);
    cases.push(await loadCase(root, id, config, typeof entry === "object" ? entry.path : null));
  }
  return {
    ...document,
    path,
    id: suiteId,
    cases,
    baseline: validateBaseline(document.baseline),
    thresholds: merge(config.eval.thresholds, document.thresholds || {}),
    retry: document.retry || { max_attempts: 1, new_run_id_per_attempt: true },
  };
}

export function resolveFixture(root, caseSpec) {
  if (!caseSpec.fixture) return null;
  const fixture = resolve(root, caseSpec.fixture);
  if (!fixture.startsWith(resolve(root))) throw new ManifestValidationError(`Fixture escapes repository root: ${caseSpec.fixture}`);
  return fixture;
}
