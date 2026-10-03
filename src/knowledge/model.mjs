export const SOURCE_TIERS = Object.freeze([
  "formal_standards",
  "industry_framework",
  "primary_technical",
  "established_expert",
  "empirical",
  "community",
]);

export const SOURCE_RATINGS = Object.freeze(["high", "medium", "low", "unknown"]);
export const SOURCE_PREFERENCES = Object.freeze(["preferred", "neutral", "avoid"]);
export const SOURCE_COLLECTION_STATUSES = Object.freeze(["not_collected", "collected", "unavailable"]);

export function createSource(fields = {}) {
  return { schema_version: 1, ...fields };
}

export function createClaim(fields = {}) {
  return { schema_version: 1, ...fields };
}

export const PRINCIPLE_STRENGTHS = Object.freeze(["MUST", "SHOULD", "MAY"]);
export const PRINCIPLE_STATUSES = Object.freeze(["candidate", "reviewed", "approved", "deprecated"]);

export function createPrinciple(fields = {}) {
  return { schema_version: 1, ...fields };
}

export const EVIDENCE_TYPES = Object.freeze(["loadtest", "benchmark", "incident", "production_metric", "failure_test"]);
export const EVIDENCE_EXECUTION_STATUSES = Object.freeze(["completed", "failed", "interrupted"]);
export const EVIDENCE_MEASUREMENT_VALIDITIES = Object.freeze(["valid", "invalid", "not_applicable"]);

export function createEvidence(fields = {}) {
  return { schema_version: 1, ...fields };
}
