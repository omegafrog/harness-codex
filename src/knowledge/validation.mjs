import { createHash } from "node:crypto";

import { PRINCIPLE_STATUSES, PRINCIPLE_STRENGTHS, SOURCE_COLLECTION_STATUSES, SOURCE_PREFERENCES, SOURCE_RATINGS, SOURCE_TIERS } from "./model.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const SOURCE_FIELDS = new Set([
  "schema_version", "id", "title", "uri", "publisher", "tier", "authority", "independent_authority_id",
  "recency", "relevance", "commercial_bias", "primary_source", "preference", "domain_metadata",
  "discovered_at", "collection_status", "collected_at", "content_sha256", "unavailable_reason",
]);
const CLAIM_FIELDS = new Set(["schema_version", "id", "source_id", "statement", "locator", "retrieved_at", "context", "qualifiers"]);
const LOCATOR_FIELDS = new Set(["section", "page", "paragraph", "anchor", "uri_fragment", "excerpt"]);
const PRINCIPLE_FIELDS = new Set(["schema_version", "id", "title", "statement", "strength", "consensus", "applies_when", "exceptions", "supporting_claim_ids", "contradicting_claim_ids", "corroboration", "countersearch", "unresolved_counter_evidence", "review", "status", "approval", "history", "deprecated_reason"]);
const COUNTERSEARCH_FIELDS = new Set(["query", "searched_at", "result", "scope", "assessment"]);
const CORROBORATION_FIELDS = new Set(["independent_authority_id", "claim_ids", "assessment"]);
const PRINCIPLE_REVIEW_FIELDS = new Set(["actor", "outcome", "assessment"]);
const PRINCIPLE_APPROVAL_FIELDS = new Set(["actor_type", "actor", "approved_at", "body_sha256"]);
const PRINCIPLE_HISTORY_FIELDS = new Set(["status", "at", "actor"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function requiredText(value, path, errors, code = "missing_text") {
  if (typeof value !== "string" || !value.trim()) issue(errors, code, path, "A non-empty string is required.");
}

export function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z" && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function timestamp(value, path, errors) {
  if (!isValidTimestamp(value)) {
    issue(errors, "invalid_timestamp", path, "Timestamp must be an ISO 8601 date-time with a timezone.");
  }
}

export function validateSource(source) {
  const errors = [];
  if (!isRecord(source)) return { valid: false, errors: [{ code: "invalid_source", path: "$", message: "Source must be an object." }] };
  for (const key of Object.keys(source)) if (!SOURCE_FIELDS.has(key)) issue(errors, "unknown_source_field", `$.${key}`, `Unsupported Source field: ${key}`);
  if (source.schema_version !== 1) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 1.");
  if (typeof source.id !== "string" || !SAFE_ID.test(source.id)) issue(errors, "invalid_source_id", "$.id", "Source ID must be a safe stable identifier.");
  for (const field of ["title", "uri", "publisher", "authority", "independent_authority_id"]) requiredText(source[field], `$.${field}`, errors);
  if (typeof source.uri === "string" && !/^https?:\/\//i.test(source.uri)) issue(errors, "invalid_source_uri", "$.uri", "Source URI must use HTTP or HTTPS.");
  if (!SOURCE_TIERS.includes(source.tier)) issue(errors, "invalid_source_tier", "$.tier", "Source tier is not supported.");
  for (const field of ["recency", "relevance", "commercial_bias"]) if (!SOURCE_RATINGS.includes(source[field])) issue(errors, `invalid_${field}`, `$.${field}`, `${field} must be high, medium, low, or unknown.`);
  if (typeof source.primary_source !== "boolean") issue(errors, "invalid_primary_source", "$.primary_source", "primary_source must be a boolean.");
  if (!SOURCE_PREFERENCES.includes(source.preference)) issue(errors, "invalid_preference", "$.preference", "preference must be preferred, neutral, or avoid.");
  if (!isRecord(source.domain_metadata) || Object.values(source.domain_metadata).some((value) => typeof value !== "string" || !value.trim())) {
    issue(errors, "invalid_domain_metadata", "$.domain_metadata", "domain_metadata must be a mapping of non-empty strings.");
  }
  timestamp(source.discovered_at, "$.discovered_at", errors);
  if (!SOURCE_COLLECTION_STATUSES.includes(source.collection_status)) issue(errors, "invalid_collection_status", "$.collection_status", "collection_status is not supported.");
  if (source.collection_status === "collected") {
    timestamp(source.collected_at, "$.collected_at", errors);
    if (typeof source.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.content_sha256)) issue(errors, "invalid_content_hash", "$.content_sha256", "Collected source content requires a lowercase SHA-256 digest.");
    if (source.unavailable_reason !== undefined) issue(errors, "unexpected_unavailable_reason", "$.unavailable_reason", "Collected source cannot have an unavailable reason.");
  } else if (source.collection_status === "unavailable") {
    requiredText(source.unavailable_reason, "$.unavailable_reason", errors);
    if (source.content_sha256 !== undefined || source.collected_at !== undefined) issue(errors, "unavailable_source_has_content", "$", "Unavailable source cannot claim collected content.");
  } else if (source.collected_at !== undefined || source.content_sha256 !== undefined || source.unavailable_reason !== undefined) {
    issue(errors, "uncollected_source_has_collection_result", "$", "A not-collected source cannot contain a collection result.");
  }
  return { valid: errors.length === 0, errors };
}

export function validateClaim(claim, refs = {}) {
  const errors = [];
  if (!isRecord(claim)) return { valid: false, errors: [{ code: "invalid_claim", path: "$", message: "Claim must be an object." }] };
  for (const key of Object.keys(claim)) if (!CLAIM_FIELDS.has(key)) issue(errors, "unknown_claim_field", `$.${key}`, `Unsupported Claim field: ${key}`);
  if (claim.schema_version !== 1) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 1.");
  if (typeof claim.id !== "string" || !SAFE_ID.test(claim.id)) issue(errors, "invalid_claim_id", "$.id", "Claim ID must be a safe stable identifier.");
  if (typeof claim.source_id !== "string" || !SAFE_ID.test(claim.source_id)) issue(errors, "invalid_source_ref", "$.source_id", "Claim must reference a safe Source ID.");
  else if (refs.sourceIds !== undefined && !(Array.isArray(refs.sourceIds) ? refs.sourceIds : Object.keys(refs.sourceIds)).includes(claim.source_id)) issue(errors, "unknown_source_ref", "$.source_id", `Unknown Source reference: ${claim.source_id}`);
  requiredText(claim.statement, "$.statement", errors);
  if (typeof claim.statement === "string" && /[.!?](?:\s|$)/.test(claim.statement.trim().slice(0, -1))) issue(errors, "non_atomic_claim", "$.statement", "A Claim must contain one standalone assertion.");
  if (!isRecord(claim.locator)) {
    issue(errors, "invalid_locator", "$.locator", "Claim locator must be an object.");
  } else {
    for (const key of Object.keys(claim.locator)) if (!LOCATOR_FIELDS.has(key)) issue(errors, "unknown_locator_field", `$.locator.${key}`, `Unsupported locator field: ${key}`);
    const locatorFields = Object.keys(claim.locator).filter((key) => LOCATOR_FIELDS.has(key));
    if (locatorFields.length === 0) issue(errors, "missing_locator_detail", "$.locator", "Locator must identify a section, page, paragraph, anchor, URI fragment, or excerpt.");
    for (const field of locatorFields) {
      const value = claim.locator[field];
      if ((field === "page" && (!Number.isInteger(value) || value < 1)) || (field !== "page" && (typeof value !== "string" || !value.trim()))) {
        issue(errors, "invalid_locator_detail", `$.locator.${field}`, "Locator detail must be non-empty text or a positive page number.");
      }
    }
  }
  timestamp(claim.retrieved_at, "$.retrieved_at", errors);
  requiredText(claim.context, "$.context", errors);
  if (!Array.isArray(claim.qualifiers) || claim.qualifiers.some((qualifier) => typeof qualifier !== "string" || !qualifier.trim())) {
    issue(errors, "invalid_qualifiers", "$.qualifiers", "qualifiers must be a list of non-empty strings; use an empty list when none apply.");
  }
  return { valid: errors.length === 0, errors };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function principleApprovalBody(principle) {
  const bodyFields = ["title", "statement", "strength", "consensus", "applies_when", "exceptions", "supporting_claim_ids", "contradicting_claim_ids", "corroboration", "countersearch", "unresolved_counter_evidence"];
  return Object.fromEntries(bodyFields.filter((key) => principle?.[key] !== undefined).map((key) => [key, principle[key]]));
}

export function computePrincipleApprovalHash(principle) {
  return createHash("sha256").update(JSON.stringify(canonicalize(principleApprovalBody(principle)))).digest("hex");
}

function stringList(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    issue(errors, "invalid_string_list", path, "A list of non-empty strings is required.");
    return;
  }
  if (new Set(value).size !== value.length) issue(errors, "duplicate_reference", path, "References must be unique.");
}

export function validatePrinciple(principle, refs = {}) {
  const errors = [];
  if (!isRecord(principle)) return { valid: false, errors: [{ code: "invalid_principle", path: "$", message: "Principle must be an object." }] };
  for (const key of Object.keys(principle)) if (!PRINCIPLE_FIELDS.has(key)) issue(errors, "unknown_principle_field", `$.${key}`, `Unsupported Principle field: ${key}`);
  if (principle.schema_version !== 1) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 1.");
  if (typeof principle.id !== "string" || !SAFE_ID.test(principle.id)) issue(errors, "invalid_principle_id", "$.id", "Principle ID must be a safe stable identifier.");
  for (const field of ["title", "statement", "consensus"]) requiredText(principle[field], `$.${field}`, errors);
  if (!PRINCIPLE_STRENGTHS.includes(principle.strength)) issue(errors, "invalid_principle_strength", "$.strength", "strength must be MUST, SHOULD, or MAY.");
  stringList(principle.applies_when, "$.applies_when", errors);
  stringList(principle.exceptions, "$.exceptions", errors);
  for (const field of ["supporting_claim_ids", "contradicting_claim_ids"]) {
    stringList(principle[field], `$.${field}`, errors);
    if (!Array.isArray(principle[field])) continue;
    for (const id of principle[field]) {
      if (!SAFE_ID.test(id)) issue(errors, "invalid_claim_ref", `$.${field}`, `Unsafe Claim reference: ${id}`);
      else if (refs.claims !== undefined && !refs.claims.some((claim) => claim.id === id)) issue(errors, "unknown_claim_ref", `$.${field}`, `Unknown Claim reference: ${id}`);
    }
  }
  if (Array.isArray(principle.supporting_claim_ids) && Array.isArray(principle.contradicting_claim_ids) && principle.supporting_claim_ids.some((id) => principle.contradicting_claim_ids.includes(id))) {
    issue(errors, "overlapping_claim_polarity", "$", "A Claim cannot support and contradict the same Principle.");
  }
  if (!Array.isArray(principle.corroboration) || principle.corroboration.length === 0) {
    issue(errors, "missing_independent_corroboration", "$.corroboration", "At least one reviewed independent corroboration record is required.");
  } else {
    for (const [index, record] of principle.corroboration.entries()) {
      const path = `$.corroboration[${index}]`;
      if (!isRecord(record)) { issue(errors, "invalid_corroboration", path, "Corroboration record must be an object."); continue; }
      for (const key of Object.keys(record)) if (!CORROBORATION_FIELDS.has(key)) issue(errors, "unknown_corroboration_field", `${path}.${key}`, `Unsupported corroboration field: ${key}`);
      requiredText(record.independent_authority_id, `${path}.independent_authority_id`, errors);
      requiredText(record.assessment, `${path}.assessment`, errors);
      stringList(record.claim_ids, `${path}.claim_ids`, errors);
      if (Array.isArray(record.claim_ids)) for (const id of record.claim_ids) {
        if (!principle.supporting_claim_ids?.includes(id)) issue(errors, "uncited_corroboration_claim", `${path}.claim_ids`, `Corroboration Claim ${id} must appear in supporting_claim_ids.`);
        const claim = refs.claims?.find((item) => item.id === id);
        const source = refs.sources?.find((item) => item.id === claim?.source_id);
        if (source && source.independent_authority_id !== record.independent_authority_id) issue(errors, "corroboration_authority_mismatch", `${path}.independent_authority_id`, "Corroboration authority must match its Claim Source.");
      }
    }
  }
  if (!Array.isArray(principle.countersearch) || principle.countersearch.length === 0) {
    issue(errors, "missing_countersearch", "$.countersearch", "At least one mandatory countersearch record is required.");
  } else {
    for (const [index, record] of principle.countersearch.entries()) {
      const path = `$.countersearch[${index}]`;
      if (!isRecord(record)) { issue(errors, "invalid_countersearch", path, "Countersearch record must be an object."); continue; }
      for (const key of Object.keys(record)) if (!COUNTERSEARCH_FIELDS.has(key)) issue(errors, "unknown_countersearch_field", `${path}.${key}`, `Unsupported countersearch field: ${key}`);
      requiredText(record.query, `${path}.query`, errors);
      timestamp(record.searched_at, `${path}.searched_at`, errors);
      requiredText(record.result, `${path}.result`, errors);
      if (typeof record.scope !== "string" || !record.scope.trim()) issue(errors, "missing_countersearch_scope", `${path}.scope`, "Countersearch scope is required, including for searches with no results.");
      requiredText(record.assessment, `${path}.assessment`, errors);
    }
  }
  if (principle.unresolved_counter_evidence !== undefined) stringList(principle.unresolved_counter_evidence, "$.unresolved_counter_evidence", errors);
  if (principle.review !== undefined) {
    if (!isRecord(principle.review)) issue(errors, "invalid_principle_review", "$.review", "Principle review must be an object.");
    else {
      for (const key of Object.keys(principle.review)) if (!PRINCIPLE_REVIEW_FIELDS.has(key)) issue(errors, "unknown_principle_review_field", `$.review.${key}`, `Unsupported Principle review field: ${key}`);
      for (const field of ["actor", "outcome", "assessment"]) requiredText(principle.review[field], `$.review.${field}`, errors);
      if (!new Set(["accepted", "needs_evidence", "needs_revision"]).has(principle.review.outcome)) issue(errors, "invalid_principle_review_outcome", "$.review.outcome", "Principle review outcome is unsupported.");
    }
  }
  if (!PRINCIPLE_STATUSES.includes(principle.status)) issue(errors, "invalid_principle_status", "$.status", "Principle status is not supported.");
  if (principle.status === "reviewed" || principle.status === "approved") {
    if (!principle.review || principle.review.outcome !== "accepted") issue(errors, "missing_accepted_review", "$.review", "Reviewed Principle requires an accepted Reviewer assessment.");
    if (principle.unresolved_counter_evidence?.length) issue(errors, "unresolved_counter_evidence", "$.unresolved_counter_evidence", "Material counter-evidence must be resolved before review or approval.");
  }
  if (principle.status === "approved") {
    if (isRecord(principle.approval)) for (const key of Object.keys(principle.approval)) if (!PRINCIPLE_APPROVAL_FIELDS.has(key)) issue(errors, "unknown_principle_approval_field", `$.approval.${key}`, `Unsupported Principle approval field: ${key}`);
    if (!isRecord(principle.approval) || principle.approval.actor_type !== "human" || !principle.approval.actor || !isValidTimestamp(principle.approval.approved_at)) {
      issue(errors, "missing_human_approval", "$.approval", "Approved Principle requires an explicit human approval record.");
    } else if (principle.approval.body_sha256 !== computePrincipleApprovalHash(principle)) {
      issue(errors, "approval_hash_mismatch", "$.approval.body_sha256", "Principle substantive content changed after approval.");
    }
  }
  if (principle.status === "deprecated") requiredText(principle.deprecated_reason, "$.deprecated_reason", errors);
  if (principle.history !== undefined) {
    if (!Array.isArray(principle.history) || principle.history.some((entry) => !isRecord(entry) || !PRINCIPLE_STATUSES.includes(entry.status) || typeof entry.actor !== "string" || !entry.actor.trim() || !isValidTimestamp(entry.at) || Object.keys(entry).some((key) => !PRINCIPLE_HISTORY_FIELDS.has(key)))) {
      issue(errors, "invalid_principle_history", "$.history", "Principle history must contain only status, actor, and timestamp records.");
    }
  }
  return { valid: errors.length === 0, errors };
}
