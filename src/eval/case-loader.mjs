import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { HARD_GATE_IDS, REQUIRED_OUTCOME_IDS } from "./contracts.mjs";
import { EvalInconclusiveError, ManifestValidationError } from "./errors.mjs";
import { parseYaml } from "./yaml.mjs";
import { isWithin } from "./util.mjs";
import { validateRecordingFixture } from "./recording.mjs";
import { loadNamedWorkflow } from "../workflow/index.mjs";

const DEFAULT_EVAL_CONFIG = {
  suite_paths: "evals/suites",
  case_paths: "evals/cases",
  runtime_path: ".codex/evals/.runtime",
  default_environment_profile: "p0-default",
  default_recording_mode: "replay",
  default_case_timeout_ms: 120000,
  environment_profiles: {
    "p0-default": {
      permission_profile: "eval-workspace",
      sandbox: "workspace-write",
      network: "restricted",
    },
  },
  codex: { command: ["codex", "exec", "--json"], auth_mode: "isolated" },
  thresholds: {
    hard_gate_failures: 0,
    critical_case_pass_rate: 1,
    pass_rate: 0.95,
    mean_quality: 0.8,
    p10_quality: 0.65,
    max_token_regression: 0.2,
    max_latency_regression: 0.25,
    max_inconclusive_rate: 0.05,
    minimum_conclusive_cases: 0.95,
  },
};

const DEFAULT_RETRY_POLICY = {
  runner: { automatic: false },
  owner: ["suite", "ci"],
  max_attempts: 1,
  retry_on: ["inconclusive"],
  retry_on_failed: false,
  new_run_id_per_attempt: true,
};

const RESERVED_EVAL_ENV_KEYS = new Set([
  "HARNESS_EVAL_CASE_ID",
  "HARNESS_EVAL_CASE_ATTEMPT",
  "HARNESS_EVAL_WORKSPACE",
  "HARNESS_EVAL_RUN_DIR",
  "HARNESS_EVAL_ENVIRONMENT_PROFILE",
  "HARNESS_EVAL_CASE_MANIFEST",
  "HARNESS_EVAL_WORKFLOW",
  "HARNESS_EVAL_PERMISSION_PROFILE",
  "HARNESS_EVAL_NATIVE_SANDBOX",
  "HARNESS_EVAL_NETWORK_POLICY",
  "HARNESS_EVAL_EXTERNAL_PORT_MODE",
  "HARNESS_EVAL_EXTERNAL_RECORDING",
  "HARNESS_EVAL_EXTERNAL_RUNTIME",
  "HARNESS_EVAL_EXTERNAL_EVENTS",
  "HARNESS_EVAL_EXTERNAL_MUTATION",
  "HARNESS_EVAL_INTEGRATION",
  "HARNESS_EVAL_EXTERNAL_PORT_COMMAND",
  "HARNESS_EVAL_MODEL",
  "HARNESS_EVAL_MODEL_CONFIG",
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
]);

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestValidationError(`${label} must be an object`);
  return value;
}

function asNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ManifestValidationError(`${label} must be a non-empty string`);
  return value;
}

function isPortableAbsolutePath(value) {
  return isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value);
}

function asSafeIdentifier(value, label) {
  const identifier = asNonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) throw new ManifestValidationError(`${label} must be a safe path identifier`);
  return identifier;
}

function validateEnvironmentOverrides(environment, label) {
  if (environment === undefined || environment === null) return;
  const value = asObject(environment, label);
  if (value.env === undefined || value.env === null) return;
  const env = asObject(value.env, `${label}.env`);
  const reserved = Object.keys(env).find((key) => RESERVED_EVAL_ENV_KEYS.has(key));
  if (reserved) throw new ManifestValidationError(`${label}.env.${reserved} is reserved by the eval runner`);
}

function asIdList(value, label, registry) {
  if (!Array.isArray(value) || value.length === 0) throw new ManifestValidationError(`${label} must be a non-empty list`);
  for (const item of value) {
    if (typeof item !== "string" || !registry.has(item)) throw new ManifestValidationError(`Unknown ${label} id: ${item}`);
  }
  return value;
}

function validateOutcomeEvidence(value, requiredOutcome, label) {
  const evidence = asObject(value, label);
  for (const id of requiredOutcome) {
    if (!(id in evidence)) throw new ManifestValidationError(`${label}.${id} is required for outcome ${id}`);
    const rule = asObject(evidence[id], `${label}.${id}`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.some((action) => typeof action !== "string" || !action.trim())) {
      throw new ManifestValidationError(`${label}.${id}.actions must be a non-empty list of strings`);
    }
    if (rule.actor !== undefined) asNonEmptyString(rule.actor, `${label}.${id}.actor`);
    if (rule.target_prefix !== undefined) asNonEmptyString(rule.target_prefix, `${label}.${id}.target_prefix`);
    if (!Array.isArray(rule.required_files) || rule.required_files.length === 0 || rule.required_files.some((file) => typeof file !== "string" || !file.trim() || isPortableAbsolutePath(file) || file.split(/[\\/]/).includes(".."))) {
      throw new ManifestValidationError(`${label}.${id}.required_files must contain at least one repository-relative path`);
    }
  }
  return evidence;
}

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(base[key] || {}, value) : value;
  return result;
}

export function resolvePortablePath(root, value) {
  if (typeof value !== "string") return null;
  const normalized = process.platform === "win32" ? value.replaceAll("/", "\\") : value.replaceAll("\\", "/");
  if (process.platform !== "win32" && win32.isAbsolute(value) && !posix.isAbsolute(value)) return null;
  return isAbsolute(normalized) || posix.isAbsolute(normalized) || win32.isAbsolute(normalized)
    ? normalized
    : resolve(root, normalized);
}

async function validateRepositoryPath(root, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ManifestValidationError(`${label} must be a non-empty repository-relative path`);
  const path = resolvePortablePath(root, value);
  if (!path || !isWithin(root, path)) throw new ManifestValidationError(`${label} escapes repository root: ${value}`);
  let probe = path;
  while (true) {
    try {
      const actual = await realpath(probe);
      if (!isWithin(root, actual)) throw new ManifestValidationError(`${label} resolves outside repository root: ${value}`);
      break;
    } catch (error) {
      if (error instanceof ManifestValidationError || error.code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return path;
}

async function assertNoSymlinks(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new EvalInconclusiveError("corrupted_fixture", `${label} contains a symbolic link: ${path}`);
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await assertNoSymlinks(join(path, entry.name), label);
  }
}

export async function loadHarnessConfig(root, configPath = ".codex/harness.yaml") {
  const path = resolvePortablePath(root, configPath);
  if (!path || !isWithin(root, path)) throw new ManifestValidationError(`Config escapes repository root: ${configPath}`);
  try {
    if (!isWithin(root, await realpath(path))) throw new ManifestValidationError(`Config resolves outside repository root: ${configPath}`);
  } catch (error) {
    if (error instanceof ManifestValidationError || error.code !== "ENOENT") throw error;
  }
  const document = parseYaml(await readFile(path, "utf8"));
  const tracker = asObject(document.tracker, "tracker");
  const github = tracker.mode === "github" ? asObject(tracker.github, "tracker.github") : null;
  const evalConfig = merge(DEFAULT_EVAL_CONFIG, document.eval || {});
  const authMode = evalConfig.codex?.auth_mode || "isolated";
  if (!["isolated", "inherited"].includes(authMode)) throw new ManifestValidationError(`Invalid eval.codex.auth_mode: ${authMode}`);
  validateEnvironmentOverrides(evalConfig.environment, "eval.environment");
  await validateRepositoryPath(root, evalConfig.suite_paths, "eval.suite_paths");
  await validateRepositoryPath(root, evalConfig.case_paths, "eval.case_paths");
  await validateRepositoryPath(root, evalConfig.runtime_path, "eval.runtime_path");
  return { root, path, document, tracker: { ...tracker, ...(github ? { github } : {}) }, eval: evalConfig };
}

function validateRecording(recording) {
  const value = recording || { mode: "none" };
  asObject(value, "recording");
  if (!["replay", "none", "live"].includes(value.mode)) throw new ManifestValidationError(`Invalid recording.mode: ${value.mode}`);
  if (value.mode === "replay") asNonEmptyString(value.fixture, "recording.fixture");
  return value;
}

function validateIntegrationResource(resource, integration) {
  if (resource === undefined || resource === null) {
    if (integration) throw new ManifestValidationError("integration_resource is required for integration cases");
    return null;
  }
  if (!integration) throw new ManifestValidationError("integration_resource requires integration: true");
  const value = asObject(resource, "integration_resource");
  asNonEmptyString(value.system, "integration_resource.system");
  asNonEmptyString(value.resource_id, "integration_resource.resource_id");
  asObject(value.target, "integration_resource.target");
  if (Object.keys(value.target).length === 0) throw new ManifestValidationError("integration_resource.target must not be empty");
  if (value.dedicated !== true) throw new ManifestValidationError("integration_resource.dedicated must be true");
  return value;
}

export function validateCaseManifest(raw, source = "case") {
  const document = asObject(raw, source);
  if (document.schema_version !== 1) throw new ManifestValidationError(`${source}.schema_version must be 1`);
  const id = asSafeIdentifier(document.id, `${source}.id`);
  const workflow = asNonEmptyString(document.workflow, `${source}.workflow`);
  const requiredOutcome = asIdList(document.required_outcome, `${source}.required_outcome`, REQUIRED_OUTCOME_IDS);
  const outcomeEvidence = validateOutcomeEvidence(document.outcome_evidence, requiredOutcome, `${source}.outcome_evidence`);
  const hardGates = asIdList(document.hard_gates, `${source}.hard_gates`, HARD_GATE_IDS);
  const qualityThreshold = Number(document.quality_threshold);
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 1) throw new ManifestValidationError(`${source}.quality_threshold must be between 0 and 1`);
  const hardCaps = asObject(document.hard_caps, `${source}.hard_caps`);
  for (const key of ["max_turns", "max_tool_calls", "max_tokens", "max_latency_ms"]) {
    if (hardCaps[key] !== undefined && (!Number.isInteger(hardCaps[key]) || hardCaps[key] <= 0)) throw new ManifestValidationError(`${source}.hard_caps.${key} must be a positive integer`);
  }
  const recording = validateRecording(document.recording);
  validateEnvironmentOverrides(document.environment, `${source}.environment`);
  const integration = document.integration === true;
  const integrationResource = validateIntegrationResource(document.integration_resource, integration);
  if (recording.mode === "live" && !integration) throw new ManifestValidationError(`${source}.live recording requires integration: true`);
  return {
    ...document,
    schema_version: 1,
    id,
    workflow,
    critical: document.critical === true,
    required_outcome: requiredOutcome,
    hard_gates: hardGates,
    outcome_evidence: outcomeEvidence,
    quality_threshold: qualityThreshold,
    hard_caps: hardCaps,
    integration,
    integration_resource: integrationResource,
    recording,
    environment_profile: document.environment_profile || "p0-default",
    forbidden_actions: Array.isArray(document.forbidden_actions) ? document.forbidden_actions : [],
  };
}

export async function loadCase(root, caseId, config, explicitPath = null) {
  const safeCaseId = asSafeIdentifier(caseId, "case id");
  const path = explicitPath ? resolvePortablePath(root, explicitPath) : resolvePortablePath(root, `${config.eval.case_paths}/${safeCaseId}.yaml`);
  if (!path || !isWithin(root, path)) throw new ManifestValidationError(`Case manifest escapes repository root: ${explicitPath || caseId}`);
  try {
    if (!isWithin(root, await realpath(path))) throw new ManifestValidationError(`Case manifest resolves outside repository root: ${path}`);
    const caseSpec = { ...validateCaseManifest(parseYaml(await readFile(path, "utf8")), path), path };
    try {
      await loadNamedWorkflow(caseSpec.workflow, { root });
    } catch (error) {
      if (error?.reason === "invalid_workflow_manifest") {
        throw new EvalInconclusiveError(
          "invalid_workflow_manifest",
          `Unable to load workflow ${caseSpec.workflow}: ${error.message}`,
          { workflow: caseSpec.workflow, cause: error },
        );
      }
      throw error;
    }
    if (caseSpec.fixture) {
      const fixture = resolvePortablePath(root, caseSpec.fixture);
      if (!fixture || !isWithin(root, fixture)) throw new ManifestValidationError(`Fixture escapes repository root: ${caseSpec.fixture}`);
      if (!isWithin(root, await realpath(fixture))) throw new ManifestValidationError(`Fixture resolves outside repository root: ${caseSpec.fixture}`);
      await access(fixture);
      await assertNoSymlinks(fixture, "Fixture");
    }
    if (caseSpec.recording.mode === "replay") {
      const recording = resolvePortablePath(root, caseSpec.recording.fixture);
      if (!recording || !isWithin(root, recording)) throw new ManifestValidationError(`Recording escapes repository root: ${caseSpec.recording.fixture}`);
      if (!isWithin(root, await realpath(recording))) throw new ManifestValidationError(`Recording resolves outside repository root: ${caseSpec.recording.fixture}`);
      await access(recording);
      await validateRecordingFixture(recording);
    }
    return caseSpec;
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    if (error instanceof EvalInconclusiveError) throw error;
    throw new ManifestValidationError(`Unable to load case ${caseId}: ${error.message}`, { cause: error });
  }
}

function validateBaseline(baseline) {
  const value = asObject(baseline, "suite.baseline");
  for (const key of ["id", "harness_version", "harness_commit", "model", "model_config", "environment_profile", "source_run_id"]) asNonEmptyString(value[key], `suite.baseline.${key}`);
  const validateMetrics = (metrics, label, required = false) => {
    if (metrics === undefined || metrics === null) {
      if (required) throw new ManifestValidationError(`${label} is required`);
      return null;
    }
    const result = asObject(metrics, label);
    if (required && (result.tokens === undefined || result.latency_ms === undefined)) throw new ManifestValidationError(`${label} must include tokens and latency_ms`);
    for (const key of ["tokens", "latency_ms", "tool_calls", "turns", "handoffs"]) {
      if (result[key] !== undefined && (!Number.isFinite(Number(result[key])) || Number(result[key]) < 0)) throw new ManifestValidationError(`${label}.${key} must be a non-negative number`);
    }
    return result;
  };
  validateMetrics(value.metrics, "suite.baseline.metrics", true);
  const caseMetrics = asObject(value.case_metrics, "suite.baseline.case_metrics");
  for (const [caseId, metrics] of Object.entries(caseMetrics)) validateMetrics(metrics, `suite.baseline.case_metrics.${caseId}`, true);
  return { ...value, metrics: value.metrics, case_metrics: caseMetrics };
}

function validateRetryPolicy(retry) {
  const value = { ...DEFAULT_RETRY_POLICY, ...(retry || {}) };
  const runner = asObject(value.runner, "suite.retry.runner");
  if (runner.automatic !== false) throw new ManifestValidationError("suite.retry.runner.automatic must be false");
  if (!Array.isArray(value.owner) || value.owner.length === 0 || value.owner.some((owner) => !["suite", "ci"].includes(owner))) throw new ManifestValidationError("suite.retry.owner must contain suite or ci");
  if (!Number.isInteger(value.max_attempts) || value.max_attempts < 1) throw new ManifestValidationError("suite.retry.max_attempts must be a positive integer");
  if (!Array.isArray(value.retry_on) || value.retry_on.some((reason) => reason !== "inconclusive")) throw new ManifestValidationError("suite.retry.retry_on may only contain inconclusive");
  if (value.retry_on_failed !== false) throw new ManifestValidationError("suite.retry.retry_on_failed must be false");
  if (value.new_run_id_per_attempt !== true) throw new ManifestValidationError("suite.retry.new_run_id_per_attempt must be true");
  return { runner: { automatic: false }, owner: [...value.owner], max_attempts: value.max_attempts, retry_on: [...value.retry_on], retry_on_failed: false, new_run_id_per_attempt: true };
}

export async function loadSuite(root, suiteId, config) {
  asSafeIdentifier(suiteId, "suite id");
  const path = resolvePortablePath(root, `${config.eval.suite_paths}/${suiteId}.yaml`);
  if (!path || !isWithin(root, path)) throw new ManifestValidationError(`Suite manifest escapes repository root: ${suiteId}`);
  let raw;
  try {
    if (!isWithin(root, await realpath(path))) throw new ManifestValidationError(`Suite manifest resolves outside repository root: ${path}`);
    raw = parseYaml(await readFile(path, "utf8"));
  } catch (error) {
    throw new ManifestValidationError(`Unable to load suite ${suiteId}: ${error.message}`, { cause: error });
  }
  const document = asObject(raw, path);
  if (document.schema_version !== 1) throw new ManifestValidationError(`${path}.schema_version must be 1`);
  if (document.id !== suiteId) throw new ManifestValidationError(`Suite id mismatch: expected ${suiteId}, got ${document.id}`);
  if (!Array.isArray(document.cases) || document.cases.length === 0) throw new ManifestValidationError(`${path}.cases must be a non-empty list`);
  const cases = [];
  const seenCaseIds = new Set();
  for (const entry of document.cases) {
    const id = typeof entry === "string" ? entry : entry?.id;
    asSafeIdentifier(id, `${path}.cases[]`);
    if (seenCaseIds.has(id)) throw new ManifestValidationError(`${path}.cases must not contain duplicate case identifiers`);
    seenCaseIds.add(id);
    const caseSpec = await loadCase(root, id, config, typeof entry === "object" ? entry.path : null);
    if (!config.eval.environment_profiles?.[caseSpec.environment_profile]) throw new ManifestValidationError(`Unknown environment profile: ${caseSpec.environment_profile}`);
    const profile = config.eval.environment_profiles[caseSpec.environment_profile];
    if (typeof profile.permission_profile !== "string" || !["restricted", "disabled", "allowed"].includes(profile.network) || !["read-only", "workspace-write"].includes(profile.sandbox)) throw new ManifestValidationError(`Incomplete or unsafe environment profile: ${caseSpec.environment_profile}`);
    if (profile.network === "allowed" && !(caseSpec.integration && caseSpec.recording.mode === "live")) throw new ManifestValidationError(`Unrestricted network requires an explicit live integration case: ${caseSpec.environment_profile}`);
    cases.push(caseSpec);
  }
  const baseline = validateBaseline(document.baseline);
  const baselineCaseIds = new Set(Object.keys(baseline.case_metrics));
  const suiteCaseIds = new Set(cases.map((caseSpec) => caseSpec.id));
  if (baselineCaseIds.size !== suiteCaseIds.size || [...suiteCaseIds].some((caseId) => !baselineCaseIds.has(caseId))) throw new ManifestValidationError(`${path}.baseline.case_metrics must contain exactly one snapshot for every suite case`);
  return {
    ...document,
    path,
    id: suiteId,
    cases,
    baseline,
    thresholds: merge(config.eval.thresholds, document.thresholds || {}),
    retry: validateRetryPolicy(document.retry),
  };
}

export function resolveFixture(root, caseSpec) {
  if (!caseSpec.fixture) return null;
  const fixture = resolvePortablePath(root, caseSpec.fixture);
  if (!fixture || !isWithin(root, fixture)) throw new ManifestValidationError(`Fixture escapes repository root: ${caseSpec.fixture}`);
  return fixture;
}
