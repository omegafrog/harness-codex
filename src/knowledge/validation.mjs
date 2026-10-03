import { SOURCE_COLLECTION_STATUSES, SOURCE_PREFERENCES, SOURCE_RATINGS, SOURCE_TIERS } from "./model.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SOURCE_FIELDS = new Set([
  "schema_version", "id", "title", "uri", "publisher", "tier", "authority", "independent_authority_id",
  "recency", "relevance", "commercial_bias", "primary_source", "preference", "domain_metadata",
  "discovered_at", "collection_status", "collected_at", "content_sha256", "unavailable_reason",
]);
const CLAIM_FIELDS = new Set(["schema_version", "id", "source_id", "statement", "locator", "retrieved_at", "context", "qualifiers"]);
const LOCATOR_FIELDS = new Set(["section", "page", "paragraph", "anchor", "uri_fragment", "excerpt"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function requiredText(value, path, errors, code = "missing_text") {
  if (typeof value !== "string" || !value.trim()) issue(errors, code, path, "A non-empty string is required.");
}

function timestamp(value, path, errors) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
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
