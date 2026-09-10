function structuredOutcome(value, id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.outcome === id || value.outcomes?.includes?.(id) || value.results?.[id] === true) return true;
  return value[id] === true && (value.kind === "outcome" || value.type === "outcome");
}

export function gradeOutcome({ caseSpec, trajectory = [], events = [], finalOutput = "", execution = {} }) {
  const results = {};
  for (const id of caseSpec.required_outcome) {
    const eventMatch = events.some((event) => event.type === id || structuredOutcome(event.payload, id));
    const trajectoryMatch = trajectory.some((record) => record.action === id || structuredOutcome(record.payload, id));
    results[id] = eventMatch || trajectoryMatch;
  }
  return {
    passed: Object.values(results).every(Boolean),
    results,
    missing: Object.entries(results).filter(([, passed]) => !passed).map(([id]) => id),
  };
}
