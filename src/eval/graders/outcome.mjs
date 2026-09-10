function containsOutcome(value, id) {
  if (!value) return false;
  if (typeof value === "string") return value.includes(`[OUTCOME:${id}]`) || value.includes(`outcome:${id}`);
  if (Array.isArray(value)) return value.some((item) => containsOutcome(item, id));
  if (typeof value === "object") return value.outcome === id || value[id] === true || Object.values(value).some((item) => containsOutcome(item, id));
  return false;
}

export function gradeOutcome({ caseSpec, trajectory = [], events = [], finalOutput = "", execution = {} }) {
  const results = {};
  for (const id of caseSpec.required_outcome) {
    const eventMatch = events.some((event) => event.type === id || event.payload?.outcome === id || containsOutcome(event.payload, id));
    const trajectoryMatch = trajectory.some((record) => record.action === id || containsOutcome(record.payload, id));
    const outputMatch = containsOutcome(finalOutput, id);
    const processMatch = id === "tests_passed" && execution.exitCode === 0;
    results[id] = eventMatch || trajectoryMatch || outputMatch || processMatch;
  }
  return {
    passed: Object.values(results).every(Boolean),
    results,
    missing: Object.entries(results).filter(([, passed]) => !passed).map(([id]) => id),
  };
}
