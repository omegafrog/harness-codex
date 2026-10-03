import { readSystemTargets } from "../decision/artifacts.mjs";

export const SYSTEM_TARGET_GATE_ID = "system_targets_complete";
const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function evaluateSystemTargetsComplete({ root = process.cwd(), ticketId }) {
  const safeTicketId = typeof ticketId === "string" && SAFE_TICKET_ID.test(ticketId) ? ticketId : "<invalid-ticket-id>";
  const evidencePath = `docs/specs/${safeTicketId}/system-targets.yaml`;
  try {
    await readSystemTargets({ root, ticketId });
    return {
      status: "pass",
      rule_id: SYSTEM_TARGET_GATE_ID,
      reason: "System Targets are structurally complete.",
      evidence_path: evidencePath,
      violations: [],
    };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      status: missing ? "blocked" : "fail",
      rule_id: SYSTEM_TARGET_GATE_ID,
      reason: missing ? "System Targets artifact is missing." : "System Targets could not be validated.",
      evidence_path: evidencePath,
      violations: error?.validation?.errors ?? [{ code: missing ? "missing_artifact" : "invalid_artifact", path: evidencePath, message: error.message }],
    };
  }
}

const REGISTERED_STAGE_GATES = new Map([
  [SYSTEM_TARGET_GATE_ID, evaluateSystemTargetsComplete],
]);

export async function evaluateStageGates({ workflow, stageId, root = process.cwd(), ticketId }) {
  const stage = workflow?.stages?.find((candidate) => candidate.id === stageId);
  if (!stage) throw new TypeError(`Unknown workflow stage: ${stageId}`);
  const results = [];
  for (const ruleId of stage.gates ?? []) {
    const evaluator = REGISTERED_STAGE_GATES.get(ruleId);
    if (!evaluator) throw new TypeError(`No stage gate evaluator is registered for: ${ruleId}`);
    results.push(await evaluator({ root, ticketId }));
  }
  return results;
}
