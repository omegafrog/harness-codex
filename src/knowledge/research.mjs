import { SOURCE_TIERS } from "./model.mjs";
import { validateSource } from "./validation.mjs";

const TIER_PRIORITY = new Map(SOURCE_TIERS.map((tier, index) => [tier, index + 1]));

export function rankSourceTiers(sources) {
  return [...sources].sort((left, right) => (TIER_PRIORITY.get(left.tier) ?? Number.MAX_SAFE_INTEGER) - (TIER_PRIORITY.get(right.tier) ?? Number.MAX_SAFE_INTEGER));
}

export function evaluateSource(source) {
  const validation = validateSource(source);
  const dimensions = {
    authority: source?.authority,
    independence: source?.independent_authority_id,
    recency: source?.recency,
    relevance: source?.relevance,
    commercial_bias: source?.commercial_bias,
    primary_source: source?.primary_source,
    preference: source?.preference,
    domain_metadata: source?.domain_metadata,
  };
  const community = source?.tier === "community";
  return {
    valid: validation.valid,
    errors: validation.errors,
    tier_priority: TIER_PRIORITY.get(source?.tier) ?? null,
    qualification: validation.valid ? (community ? "not_independent_support" : "qualified") : "unqualified",
    can_stand_alone_for_principle: false,
    dimensions,
  };
}

export function groupIndependentAuthorities(sources) {
  const groups = new Map();
  for (const source of sources) {
    const authorityId = typeof source.independent_authority_id === "string" && source.independent_authority_id.trim()
      ? source.independent_authority_id
      : `unknown:${source.id}`;
    if (!groups.has(authorityId)) groups.set(authorityId, []);
    groups.get(authorityId).push(source.id);
  }
  return {
    independent_authority_count: groups.size,
    groups: [...groups.entries()].map(([independent_authority_id, source_ids]) => ({ independent_authority_id, source_ids })),
  };
}
