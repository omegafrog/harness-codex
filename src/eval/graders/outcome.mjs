function actionEvidenceMatches(record, rule, trajectory) {
  if (!record || record.kind !== "tool_result" || record.status !== "success") return false;
  if (!record.correlation_id || !trajectory.some((call) => call.kind === "tool_call"
    && call.correlation_id === record.correlation_id
    && call.action === record.action
    && call.target === record.target)) return false;
  if (!Array.isArray(rule.actions) || !rule.actions.includes(record.action)) return false;
  if (rule.actor && record.actor !== rule.actor) return false;
  if (rule.target_prefix && (!record.target || !String(record.target).startsWith(rule.target_prefix))) return false;
  return true;
}

function artifactEvidenceMatches(rule, artifactEvidence) {
  const requiredFiles = Array.isArray(rule.required_files) ? rule.required_files : [];
  const actualFiles = new Set(Array.isArray(artifactEvidence?.files) ? artifactEvidence.files : []);
  return requiredFiles.every((file) => actualFiles.has(file));
}

export function gradeOutcome({ caseSpec, trajectory = [], artifactEvidence = {} }) {
  const results = {};
  for (const id of caseSpec.required_outcome) {
    const rule = caseSpec.outcome_evidence?.[id];
    results[id] = Boolean(rule && trajectory.some((record) => actionEvidenceMatches(record, rule, trajectory)) && artifactEvidenceMatches(rule, artifactEvidence));
  }
  return {
    passed: Object.values(results).every(Boolean),
    results,
    missing: Object.entries(results).filter(([, passed]) => !passed).map(([id]) => id),
  };
}
