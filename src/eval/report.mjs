import { writeJsonAtomic } from "./util.mjs";

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

export function evaluateSuite({ suite, caseResults }) {
  const total = caseResults.length;
  const conclusive = caseResults.filter((result) => result.state !== "inconclusive");
  const passed = caseResults.filter((result) => result.state === "passed");
  const critical = caseResults.filter((result) => result.critical);
  const criticalConclusive = critical.filter((result) => result.state !== "inconclusive");
  const qualityValues = conclusive.map((result) => Number(result.quality?.quality || 0));
  const meanQuality = qualityValues.length ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length : 0;
  const p10Quality = p10(qualityValues);
  const efficiency = caseResults.reduce((sum, result) => {
    for (const key of ["tokens", "latency_ms", "tool_calls", "turns", "handoffs"]) sum[key] = (sum[key] || 0) + Number(result.efficiency?.[key] || 0);
    return sum;
  }, { tokens: 0, latency_ms: 0, tool_calls: 0, turns: 0, handoffs: 0 });
  const thresholds = suite.thresholds;
  const baselineMetrics = suite.baseline.metrics || null;
  const tokenRegression = regression(efficiency, baselineMetrics, "tokens", thresholds.max_token_regression);
  const latencyRegression = regression(efficiency, baselineMetrics, "latency_ms", thresholds.max_latency_regression);
  const checks = {
    hard_gate_failures: caseResults.filter((result) => !result.hard_gates?.passed).length <= thresholds.hard_gate_failures,
    critical_case_pass_rate: criticalConclusive.length > 0 && critical.filter((result) => result.state === "passed").length / criticalConclusive.length >= thresholds.critical_case_pass_rate && critical.every((result) => result.state !== "inconclusive"),
    pass_rate: conclusive.length > 0 && passed.length / conclusive.length >= thresholds.pass_rate,
    mean_quality: meanQuality >= thresholds.mean_quality,
    p10_quality: p10Quality >= thresholds.p10_quality,
    overall: meanQuality >= thresholds.overall,
    inconclusive_rate: total === 0 ? false : (total - conclusive.length) / total <= thresholds.max_inconclusive_rate,
    minimum_conclusive_cases: total === 0 ? false : conclusive.length / total >= thresholds.minimum_conclusive_cases,
    token_regression: tokenRegression.passed,
    latency_regression: latencyRegression.passed,
  };
  return {
    schema_version: 1,
    suite_id: suite.id,
    state: Object.values(checks).every(Boolean) ? "passed" : "failed",
    passed: Object.values(checks).every(Boolean),
    counts: { total, passed: passed.length, failed: caseResults.filter((result) => result.state === "failed").length, inconclusive: total - conclusive.length, conclusive: conclusive.length },
    quality: { mean: Number(meanQuality.toFixed(4)), p10: Number(p10Quality.toFixed(4)), overall: Number(meanQuality.toFixed(4)) },
    efficiency,
    baseline: { ...suite.baseline, metrics: baselineMetrics },
    regressions: { tokens: tokenRegression, latency_ms: latencyRegression },
    checks,
    cases: caseResults,
  };
}

export async function persistReport(runDir, report) {
  await writeJsonAtomic(`${runDir}/report.json`, report);
  await writeJsonAtomic(`${runDir}/result.json`, { state: report.state, passed: report.passed, suite_id: report.suite_id, counts: report.counts, checks: report.checks });
  return report;
}
