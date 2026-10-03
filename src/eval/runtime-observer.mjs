import { collectRuntimeEvidence } from "../knowledge/runtime-evidence.mjs";

/** Collect normalized Harness execution results without affecting the case verdict. */
export async function observeHarnessExecution({ root = process.cwd(), definition, runId, caseId, caseResult }) {
  const state = caseResult?.state;
  const executionStatus = state === "passed" ? "completed" : state === "failed" ? "failed" : "interrupted";
  return collectRuntimeEvidence({
    root,
    definition,
    observation: {
      origin_project: "harness-codex",
      run_id: runId,
      event_id: caseId,
      timestamp: new Date().toISOString(),
      environment: { runtime: `node ${process.versions.node}`, platform: process.platform },
      type: "failure_test",
      execution_status: executionStatus,
      measurement_validity: state === "passed" ? "valid" : "invalid",
      observations: [{ metric: "case_result_state", value: state || "unknown", unit: "state" }],
      summary: `Harness case ${caseId} finished with state ${state || "unknown"}.`,
    },
  });
}
