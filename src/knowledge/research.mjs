import { createPrinciple, SOURCE_TIERS } from "./model.mjs";
import { validatePrinciple, validateSource } from "./validation.mjs";

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

export function synthesizePrinciple(fields, { actor = "knowledge_principle_synthesizer", at = new Date().toISOString() } = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("Principle synthesis requires an explicit structured candidate.");
  if (fields.status !== undefined && fields.status !== "candidate") throw new TypeError("Synthesis can only create a candidate Principle.");
  if (fields.approval !== undefined) throw new TypeError("Synthesis cannot attach human Principle approval.");
  return createPrinciple({ ...fields, status: "candidate", history: [...(fields.history ?? []), { status: "candidate", at, actor }] });
}

export function assessPrincipleEvidence({ principle, claims = [], sources = [], minimum_independent_authorities = 2 }) {
  const validation = validatePrinciple(principle, { claims, sources });
  const claimMap = new Map(claims.map((claim) => [claim.id, claim]));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const corroboratedClaimIds = new Set((principle?.corroboration ?? []).flatMap((record) => Array.isArray(record?.claim_ids) ? record.claim_ids : []));
  const supportSources = [...corroboratedClaimIds].map((id) => sourceMap.get(claimMap.get(id)?.source_id)).filter(Boolean);
  const qualifiedSupportSources = supportSources.filter((source) => source.tier !== "community" && validateSource(source).valid);
  const independent = groupIndependentAuthorities(qualifiedSupportSources);
  const blockers = [];
  if (qualifiedSupportSources.length === 0) blockers.push("no_qualified_support");
  if (independent.independent_authority_count < minimum_independent_authorities) blockers.push("insufficient_independent_authorities");
  if (!Array.isArray(principle?.countersearch) || principle.countersearch.length === 0) blockers.push("missing_countersearch");
  if (principle?.unresolved_counter_evidence?.length) blockers.push("unresolved_counter_evidence");
  if (principle?.review?.outcome !== "accepted") blockers.push("missing_accepted_review");
  return {
    approval_ready: validation.valid && blockers.length === 0,
    blockers: [...new Set([...blockers, ...validation.errors.map(({ code }) => code)])],
    independent_authority_count: independent.independent_authority_count,
    independent_authorities: independent.groups.map(({ independent_authority_id }) => independent_authority_id),
    qualified_support_claim_ids: (principle?.supporting_claim_ids ?? []).filter((id) => qualifiedSupportSources.some((source) => source.id === claimMap.get(id)?.source_id)),
    consensus: principle?.consensus ?? null,
    consensus_inferred: false,
  };
}
