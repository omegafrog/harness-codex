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
