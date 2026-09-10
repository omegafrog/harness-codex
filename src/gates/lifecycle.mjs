import { SCHEMA_VERSION } from "../eval/contracts.mjs";

const STATUSES = new Set(["pass", "fail", "blocked"]);

export const DEFAULT_HOOK_CHECKS = Object.freeze({
  before_dispatch: Object.freeze([
    "dependency",
    "resource_conflict",
    "workspace",
    "permission_preflight",
  ]),
  before_handoff: Object.freeze([
    "checkpoint_completeness",
    "evidence_flush",
  ]),
  before_complete: Object.freeze([
    "required_outcome",
    "tests",
    "review",
    "evidence",
  ]),
  after_merge: Object.freeze(["tracker_reconciliation"]),
});

function result(status, reason, { violations = [], evidencePath = null, details = null } = {}) {
  return {
    status,
    reason,
    evidence_path: evidencePath,
    violations: [...new Set(violations)],
    ...(details === null ? {} : { details }),
  };
}

function blocked(reason, details = null) {
  return result("blocked", reason, { details });
}

function passed(reason = "contract_satisfied", details = null) {
  return result("pass", reason, { details });
}

function failed(reason, ruleId, details = null) {
  return result("fail", reason, { violations: [ruleId], details });
}

function stateValue(state, key) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  return state[key];
}

function booleanCheck(state, key, { passKey = "passed", failReason = `${key}_failed`, missingReason = `${key}_missing`, violationKey = key } = {}) {
  const value = stateValue(state, key);
  if (!value || typeof value !== "object" || Array.isArray(value)) return blocked(missingReason);
  if (value[passKey] === true) return passed(`${key}_passed`);
  if (value[passKey] === false) return failed(failReason, violationKey);
  return blocked(missingReason);
}

function checkDependency(state) {
  const dependency = stateValue(state, "dependencies");
  if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) return blocked("dependency_evidence_missing");
  if (dependency.all_satisfied === true) return passed("dependencies_satisfied");
  if (dependency.all_satisfied === false) return failed("dependency_unsatisfied", "dependency");
  if (Array.isArray(dependency.items)) {
    if (dependency.items.some((item) => !item || item.status !== "completed")) return failed("dependency_unsatisfied", "dependency");
    return passed("dependencies_satisfied");
  }
  return blocked("dependency_evidence_missing");
}

function checkResourceConflict(state) {
  const conflict = stateValue(state, "resource_conflict");
  if (!conflict || typeof conflict !== "object" || Array.isArray(conflict)) return blocked("resource_conflict_evidence_missing");
  if (conflict.present === false || conflict.conflict === false) return passed("resource_conflict_absent");
  if (conflict.present === true || conflict.conflict === true) return failed("shared_write_resource_conflict", "resource_conflict");
  return blocked("resource_conflict_evidence_missing");
}

function checkWorkspace(state) {
  return booleanCheck(state, "workspace", {
    passKey: "valid",
    failReason: "workspace_invalid",
    missingReason: "workspace_evidence_missing",
  });
}

function checkPermissionPreflight(state) {
  return booleanCheck(state, "permission_preflight", {
    passKey: "passed",
    failReason: "permission_preflight_failed",
    missingReason: "permission_preflight_evidence_missing",
  });
}

function checkCheckpointCompleteness(state) {
  return booleanCheck(state, "checkpoint", {
    passKey: "complete",
    failReason: "checkpoint_incomplete",
    missingReason: "checkpoint_evidence_missing",
    violationKey: "checkpoint_completeness",
  });
}

function checkEvidenceFlush(state) {
  const flush = stateValue(state, "evidence_flush");
  if (!flush || typeof flush !== "object" || Array.isArray(flush)) return blocked("evidence_flush_evidence_missing");
  if (flush.durable === true || flush.flushed === true) return passed("evidence_flushed");
  return blocked("evidence_not_durable");
}

function checkRequiredOutcome(state) {
  return booleanCheck(state, "required_outcome", {
    passKey: "passed",
    failReason: "required_outcome_not_achieved",
    missingReason: "required_outcome_evidence_missing",
  });
}

function checkTests(state) {
  const tests = stateValue(state, "tests");
  if (!tests || typeof tests !== "object" || Array.isArray(tests)) return blocked("test_evidence_missing");
  if (tests.status === "passed" || tests.state === "passed" || tests.passed === true) return passed("tests_passed");
  if (["failed", "error", "cancelled"].includes(tests.status) || ["failed", "error", "cancelled"].includes(tests.state) || tests.passed === false) {
    return failed("tests_not_passed", "tests");
  }
  return blocked("tests_not_run");
}

function reviewEntries(reviews) {
  if (Array.isArray(reviews)) return new Map(reviews.map((review) => [review?.role, review]));
  if (reviews && typeof reviews === "object") return new Map(Object.entries(reviews));
  return null;
}

function checkReview(state) {
  const reviews = reviewEntries(stateValue(state, "reviews"));
  if (!reviews) return blocked("review_evidence_missing");
  const missing = ["spec", "standards"].filter((role) => !reviews.get(role));
  if (missing.length > 0) return blocked("review_evidence_missing", { missing_roles: missing });
  const unresolved = ["spec", "standards"].filter((role) => {
    const review = reviews.get(role);
    return review.state !== "passed"
      || (review.independent !== undefined && review.independent !== true)
      || (review.fresh_context !== undefined && review.fresh_context !== true);
  });
  if (unresolved.length > 0) return failed("review_not_complete", "review", { unresolved_roles: unresolved });
  return passed("reviews_passed");
}

function checkEvidence(state) {
  return booleanCheck(state, "evidence", {
    passKey: "complete",
    failReason: "evidence_incomplete",
    missingReason: "evidence_missing",
  });
}

function checkTrackerReconciliation(state) {
  return booleanCheck(state, "tracker_reconciliation", {
    passKey: "reconciled",
    failReason: "tracker_not_reconciled",
    missingReason: "tracker_reconciliation_evidence_missing",
  });
}

const DEFAULT_CHECKS = Object.freeze({
  dependency: checkDependency,
  resource_conflict: checkResourceConflict,
  workspace: checkWorkspace,
  permission_preflight: checkPermissionPreflight,
  checkpoint_completeness: checkCheckpointCompleteness,
  evidence_flush: checkEvidenceFlush,
  required_outcome: checkRequiredOutcome,
  tests: checkTests,
  review: checkReview,
  evidence: checkEvidence,
  tracker_reconciliation: checkTrackerReconciliation,
});

function validateStatus(value) {
  return typeof value === "string" && STATUSES.has(value);
}

function safeErrorMessage(error, fallback) {
  if (error instanceof Error && typeof error.message === "string" && error.message) return error.message;
  try {
    const message = String(error);
    return message || fallback;
  } catch {
    return fallback;
  }
}

function normalizeCheckResult(ruleId, value, evidencePath) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !validateStatus(value.status) || typeof value.reason !== "string" || !value.reason.trim()) {
    throw new TypeError(`Gate ${ruleId} returned a malformed verdict`);
  }
  if (value.violations !== undefined && !Array.isArray(value.violations)) throw new TypeError(`Gate ${ruleId} returned malformed violations`);
  if (value.violations?.some((violation) => typeof violation !== "string" || !violation.trim())) throw new TypeError(`Gate ${ruleId} returned malformed violations`);
  if (value.evidence_path !== undefined && value.evidence_path !== null && (typeof value.evidence_path !== "string" || !value.evidence_path.trim())) throw new TypeError(`Gate ${ruleId} returned malformed evidence_path`);
  const violations = [...new Set(value.violations || (value.status === "fail" ? [ruleId] : []))];
  if (value.status === "fail" && violations.length === 0) throw new TypeError(`Gate ${ruleId} returned a failure without violations`);
  return {
    rule_id: ruleId,
    status: value.status,
    reason: value.reason,
    evidence_path: value.evidence_path ?? evidencePath ?? null,
    violations,
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}

async function executionError({ hook, ruleId = null, reason, message, evidencePath = null, eventWriter = null }) {
  const internalEvent = {
    schema_version: SCHEMA_VERSION,
    type: "hook_execution_error",
    hook,
    rule_id: ruleId,
    reason,
    message: String(message || reason),
    evidence_path: evidencePath,
    recorded: false,
  };
  if (eventWriter !== null) {
    if (!eventWriter || typeof eventWriter.append !== "function") {
      internalEvent.persistence_error = "event_writer_invalid";
    } else {
      try {
        const event = await eventWriter.append("hook_execution_error", internalEvent, { critical: true });
        internalEvent.recorded = true;
        if (Number.isInteger(event?.seq)) internalEvent.event_seq = event.seq;
      } catch (error) {
        internalEvent.persistence_error = safeErrorMessage(error, "event_writer_failed");
      }
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    hook,
    rule_id: ruleId || `lifecycle.${hook}`,
    status: "blocked",
    reason,
    evidence_path: evidencePath,
    violations: [],
    checks: [],
    internal_event: internalEvent,
  };
}

export class LifecycleGateRegistry {
  constructor({ hooks = DEFAULT_HOOK_CHECKS, checks = {} } = {}) {
    this.hooks = new Map();
    this.checks = new Map();
    for (const [ruleId, validator] of Object.entries(DEFAULT_CHECKS)) this.register(ruleId, validator);
    for (const [ruleId, validator] of Object.entries(checks)) this.register(ruleId, validator);
    const hookNames = Object.keys(hooks);
    const expectedHookNames = Object.keys(DEFAULT_HOOK_CHECKS);
    const unsupportedHook = hookNames.find((hook) => !Object.hasOwn(DEFAULT_HOOK_CHECKS, hook));
    if (unsupportedHook) throw new TypeError(`Unsupported lifecycle hook: ${unsupportedHook}`);
    if (hookNames.length !== expectedHookNames.length || expectedHookNames.some((hook) => !hookNames.includes(hook))) throw new TypeError("Lifecycle hook configuration must contain all supported hooks");
    for (const [hook, ruleIds] of Object.entries(hooks)) {
      if (!Object.hasOwn(DEFAULT_HOOK_CHECKS, hook)) throw new TypeError(`Unsupported lifecycle hook: ${hook}`);
      if (!Array.isArray(ruleIds) || ruleIds.some((ruleId) => typeof ruleId !== "string" || !ruleId.trim())) throw new TypeError(`Hook ${hook} must list check IDs`);
      this.hooks.set(hook, [...ruleIds]);
    }
  }

  register(ruleId, validator) {
    if (typeof ruleId !== "string" || !ruleId.trim()) throw new TypeError("ruleId is required");
    if (typeof validator !== "function") throw new TypeError(`Gate ${ruleId} must be a function`);
    if (this.checks.has(ruleId)) throw new TypeError(`Gate ${ruleId} is already registered`);
    this.checks.set(ruleId, validator);
    return this;
  }

  replace(ruleId, validator) {
    if (!this.checks.has(ruleId)) throw new TypeError(`Gate ${ruleId} is not registered`);
    if (typeof validator !== "function") throw new TypeError(`Gate ${ruleId} must be a function`);
    this.checks.set(ruleId, validator);
    return this;
  }

  registerHook(hook, ruleIds) {
    if (typeof hook !== "string" || !hook.trim()) throw new TypeError("hook is required");
    if (!Object.hasOwn(DEFAULT_HOOK_CHECKS, hook)) throw new TypeError(`Unsupported lifecycle hook: ${hook}`);
    if (!Array.isArray(ruleIds) || ruleIds.some((ruleId) => typeof ruleId !== "string" || !ruleId.trim())) throw new TypeError(`Hook ${hook} must list check IDs`);
    this.hooks.set(hook, [...ruleIds]);
    return this;
  }

  listHooks() {
    return Object.fromEntries([...this.hooks.entries()].map(([hook, checks]) => [hook, [...checks]]));
  }

  async run(hook, state, options = {}) {
    return runLifecycleHook({ ...options, hook, state, registry: this });
  }
}

export async function runLifecycleHook({ hook, state = {}, registry = null, evidencePath = null, eventWriter = null } = {}) {
  if (!eventWriter || typeof eventWriter.append !== "function") throw new TypeError("eventWriter with append() is required for lifecycle gate execution");
  if (evidencePath !== null && (typeof evidencePath !== "string" || !evidencePath.trim())) throw new TypeError("evidencePath must be a non-empty string or null");
  const resolvedRegistry = registry || new LifecycleGateRegistry();
  const ruleIds = resolvedRegistry.hooks.get(hook);
  if (!Array.isArray(ruleIds)) return executionError({ hook, reason: "unknown_hook", message: `Unknown lifecycle hook: ${hook}`, evidencePath, eventWriter });
  if (ruleIds.length === 0) return executionError({ hook, reason: "empty_hook", message: `Lifecycle hook has no configured checks: ${hook}`, evidencePath, eventWriter });

  const checkResults = [];
  const internalEvents = [];
  for (const ruleId of ruleIds) {
    const validator = resolvedRegistry.checks.get(ruleId);
    if (!validator) {
      const error = await executionError({ hook, ruleId, reason: "unknown_check", message: `Unknown lifecycle check: ${ruleId}`, evidencePath, eventWriter });
      checkResults.push({ rule_id: ruleId, status: "blocked", reason: "unknown_check", evidence_path: evidencePath, violations: [] });
      internalEvents.push(error.internal_event);
      continue;
    }
    try {
      const value = await validator(state);
      checkResults.push(normalizeCheckResult(ruleId, value, evidencePath));
    } catch (error) {
      checkResults.push({ rule_id: ruleId, status: "blocked", reason: "hook_execution_error", evidence_path: evidencePath, violations: [] });
      const executionFailure = await executionError({ hook, ruleId, reason: "hook_execution_error", message: safeErrorMessage(error, "validator_threw_non_error"), evidencePath, eventWriter });
      internalEvents.push(executionFailure.internal_event);
    }
  }

  const failedChecks = checkResults.filter((check) => check.status === "fail");
  const blockedChecks = checkResults.filter((check) => check.status === "blocked");
  const status = failedChecks.length > 0 ? "fail" : blockedChecks.length > 0 ? "blocked" : "pass";
  const firstUnresolved = failedChecks[0] || blockedChecks[0] || null;
  const verdict = {
    schema_version: SCHEMA_VERSION,
    hook,
    rule_id: `lifecycle.${hook}`,
    status,
    reason: firstUnresolved?.reason || "all_checks_passed",
    evidence_path: evidencePath,
    checks: checkResults,
    violations: [...new Set(failedChecks.flatMap((check) => check.violations))],
  };
  if (internalEvents.length > 0) {
    verdict.internal_events = internalEvents;
    verdict.internal_event = internalEvents[0];
  }
  return verdict;
}
