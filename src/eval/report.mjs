import { writeJsonAtomic } from "./util.mjs";

const EFFICIENCY_KEYS = ["tokens", "latency_ms", "tool_calls", "turns", "handoffs"];

function p10(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)];
}

function regression(current, baseline, key, limit) {
  if (!baseline || !Number.isFinite(Number(baseline[key])) || Number(baseline[key]) <= 0) return { available: false, ratio: null, passed: true };
  const ratio = (Number(current[key]) - Number(baseline[key])) / Number(baseline[key]);
  return { available: true, ratio: Number(ratio.toFixed(4)), passed: ratio <= limit };
}

function caseRegressions(caseResults, baselineCaseMetrics, thresholds) {
  return Object.fromEntries(caseResults.map((result) => {
    const baseline = baselineCaseMetrics?.[result.case_id] || null;
    return [result.case_id, {
      tokens: regression(result.efficiency || {}, baseline, "tokens", thresholds.max_token_regression),
      latency_ms: regression(result.efficiency || {}, baseline, "latency_ms", thresholds.max_latency_regression),
    }];
  }));
}

function sumEfficiency(results) {
  return results.reduce((sum, result) => {
    for (const key of EFFICIENCY_KEYS) sum[key] = (sum[key] || 0) + Number(result.efficiency?.[key] || 0);
    return sum;
  }, Object.fromEntries(EFFICIENCY_KEYS.map((key) => [key, 0])));
}

function emptyAttemptStats() {
  return { count: 0, passed: 0, failed: 0, inconclusive: 0, efficiency: sumEfficiency([]) };
}

function summarizeAttempts(results) {
  if (!results.length) return emptyAttemptStats();
  return {
    count: results.length,
    passed: results.filter((result) => result.state === "passed").length,
    failed: results.filter((result) => result.state === "failed").length,
    inconclusive: results.filter((result) => result.state === "inconclusive").length,
    efficiency: sumEfficiency(results),
  };
}

function reasonCounts(results) {
  return results.filter((result) => result.state === "inconclusive").reduce((counts, result) => {
    const reason = result.reason || "unknown";
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
}

export function makePreflightSuiteResult({ suiteId, runId, reason, phase = "preflight", message, runDir = null, attempt = 1, retryOf = null }) {
  const attemptNumber = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const result = {
    schema_version: 1,
    suite_id: suiteId,
    run_id: runId,
    state: "inconclusive",
    passed: false,
    reason,
    phase,
    ...(message ? { message } : {}),
    counts: { total: 0, passed: 0, failed: 0, inconclusive: 0, conclusive: 0 },
    quality: { mean: 0, p10: 0 },
    efficiency: sumEfficiency([]),
    regressions: {
      tokens: { available: false, ratio: null, passed: true },
      latency_ms: { available: false, ratio: null, passed: true },
      cases: {},
    },
    attempt: { number: attemptNumber, kind: attemptNumber === 1 ? "first" : "retry", retry_of: attemptNumber === 1 ? null : retryOf },
    attempt_stats: { first_attempt: emptyAttemptStats(), retry_attempts: emptyAttemptStats() },
    inconclusive_reasons: { [reason]: 1 },
    checks: { preflight: false },
    cases: [],
  };
  return runDir ? { ...result, run_dir: runDir } : result;
}

export function finalizeCase({ caseSpec, executionResult, cleanup, hardGates, outcome, quality, efficiency, artifacts = {} }) {
  let state = "failed";
  let reason = null;
  if (cleanup?.state === "failed") {
    state = "inconclusive";
    reason = cleanup.reason || "workspace_cleanup_failure";
  } else if (executionResult?.inconclusiveReason) {
    state = "inconclusive";
    reason = executionResult.inconclusiveReason;
  } else if (executionResult?.timedOut) {
    state = "failed";
    reason = "agent_execution_timeout";
  } else if (executionResult?.hardCapExceeded) {
    state = "failed";
    reason = "case_hard_cap_exceeded";
  } else if (!hardGates?.passed) {
    state = "failed";
    reason = "hard_gate_violation";
  } else if (executionResult?.exitCode !== 0) {
    state = "failed";
    reason = "agent_execution_failure";
  } else if (!outcome?.passed) {
    state = "failed";
    reason = "required_outcome_failure";
  } else if (!quality || quality.quality < caseSpec.quality_threshold) {
    state = "failed";
    reason = "quality_below_threshold";
  } else {
    state = "passed";
  }
  return {
    schema_version: 1,
    case_id: caseSpec.id,
    workflow: caseSpec.workflow,
    critical: caseSpec.critical,
    state,
    reason,
    passed: state === "passed",
    execution_result: {
      state: executionResult?.inconclusiveReason ? "inconclusive" : executionResult?.exitCode === 0 && !executionResult?.timedOut ? "passed" : "failed",
      exit_code: executionResult?.exitCode ?? null,
      signal: executionResult?.signal ?? null,
      duration_ms: executionResult?.durationMs ?? null,
      command: executionResult?.command || null,
    },
    cleanup: {
      state: cleanup?.state || "failed",
      reason: cleanup?.reason || null,
      ...(cleanup?.dirty !== undefined ? { dirty: cleanup.dirty } : {}),
      ...(cleanup?.dirty_files ? { dirty_files: cleanup.dirty_files } : {}),
      ...(cleanup?.workspace ? { workspace: cleanup.workspace } : {}),
    },
    hard_gates: hardGates || { passed: false, violations: [] },
    required_outcome: outcome || { passed: false, results: {} },
    quality,
    efficiency,
    artifacts,
  };
}

export function evaluateSuite({ suite, caseResults, attempt = 1, retryOf = null }) {
  const caseIds = caseResults.map((result) => result.case_id).filter((caseId) => caseId !== undefined);
  if (new Set(caseIds).size !== caseIds.length) throw new TypeError("caseResults must not contain duplicate case identifiers");
  const total = caseResults.length;
  const conclusive = caseResults.filter((result) => result.state !== "inconclusive");
  const passed = caseResults.filter((result) => result.state === "passed");
  const critical = caseResults.filter((result) => result.critical);
  const criticalConclusive = critical.filter((result) => result.state !== "inconclusive");
  const qualityValues = conclusive.map((result) => Number(result.quality?.quality || 0));
  const meanQuality = qualityValues.length ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length : 0;
  const p10Quality = p10(qualityValues);
  const efficiency = sumEfficiency(caseResults);
  const thresholds = suite.thresholds;
  const baselineMetrics = suite.baseline.metrics || null;
  const perCaseRegressions = caseRegressions(caseResults, suite.baseline.case_metrics, thresholds);
  const tokenRegression = regression(efficiency, baselineMetrics, "tokens", thresholds.max_token_regression);
  const latencyRegression = regression(efficiency, baselineMetrics, "latency_ms", thresholds.max_latency_regression);
  const attemptNumber = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const checks = {
    hard_gate_failures: caseResults.filter((result) => !result.hard_gates?.passed).length <= thresholds.hard_gate_failures,
    critical_case_pass_rate: criticalConclusive.length > 0 && critical.filter((result) => result.state === "passed").length / criticalConclusive.length >= thresholds.critical_case_pass_rate && critical.every((result) => result.state !== "inconclusive"),
    pass_rate: conclusive.length > 0 && passed.length / conclusive.length >= thresholds.pass_rate,
    mean_quality: meanQuality >= thresholds.mean_quality,
    p10_quality: p10Quality >= thresholds.p10_quality,
    inconclusive_rate: total === 0 ? false : (total - conclusive.length) / total <= thresholds.max_inconclusive_rate,
    minimum_conclusive_cases: total === 0 ? false : conclusive.length / total >= thresholds.minimum_conclusive_cases,
    token_regression: tokenRegression.passed,
    latency_regression: latencyRegression.passed,
    case_token_regression: Object.values(perCaseRegressions).every((result) => result.tokens.passed),
    case_latency_regression: Object.values(perCaseRegressions).every((result) => result.latency_ms.passed),
  };
  return {
    schema_version: 1,
    suite_id: suite.id,
    state: Object.values(checks).every(Boolean) ? "passed" : "failed",
    passed: Object.values(checks).every(Boolean),
    counts: { total, passed: passed.length, failed: caseResults.filter((result) => result.state === "failed").length, inconclusive: total - conclusive.length, conclusive: conclusive.length },
    quality: { mean: Number(meanQuality.toFixed(4)), p10: Number(p10Quality.toFixed(4)) },
    efficiency,
    baseline: { ...suite.baseline, metrics: baselineMetrics },
    regressions: { tokens: tokenRegression, latency_ms: latencyRegression, cases: perCaseRegressions },
    attempt: { number: attemptNumber, kind: attemptNumber === 1 ? "first" : "retry", retry_of: attemptNumber === 1 ? null : retryOf },
    attempt_stats: {
      first_attempt: attemptNumber === 1 ? summarizeAttempts(caseResults) : emptyAttemptStats(),
      retry_attempts: attemptNumber > 1 ? summarizeAttempts(caseResults) : emptyAttemptStats(),
    },
    inconclusive_reasons: reasonCounts(caseResults),
    checks,
    cases: caseResults,
  };
}

export function aggregateSuiteAttempts(reports) {
  if (!Array.isArray(reports)) throw new TypeError("reports must be a list");
  const first = reports.filter((report) => report?.attempt?.number === 1).flatMap((report) => report.cases || []);
  const retries = reports.filter((report) => Number(report?.attempt?.number) > 1).flatMap((report) => report.cases || []);
  return { first_attempt: summarizeAttempts(first), retry_attempts: summarizeAttempts(retries) };
}

export async function persistReport(runDir, report) {
  await writeJsonAtomic(`${runDir}/report.json`, report);
  await writeJsonAtomic(`${runDir}/result.json`, {
    state: report.state,
    passed: report.passed,
    suite_id: report.suite_id,
    counts: report.counts,
    checks: report.checks,
    attempt: report.attempt,
    attempt_stats: report.attempt_stats,
    inconclusive_reasons: report.inconclusive_reasons,
    regressions: report.regressions,
  });
  return report;
}
