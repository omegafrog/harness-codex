import { SYSTEM_CHARACTERISTIC_IDS, SYSTEM_TARGET_GROUPS } from "./model.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SYSTEM_TARGET_PROVENANCE = Object.freeze([
  "measured",
  "business_requirement",
  "user_supplied",
  "estimated",
  "external_reference",
  "assumption",
]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const TARGET_FIELDS = new Set(["id", "metric", "status", "value", "unit", "condition", "provenance", "confidence", "rationale"]);
const ROOT_FIELDS = new Set(["schema_version", "id", "system_characteristics", "initial", "expected_growth", "architecture_boundary"]);

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMetric(target, path, group, errors, ids) {
  if (!isRecord(target)) {
    issue(errors, "invalid_target", path, "Target must be an object.");
    return;
  }
  for (const key of Object.keys(target)) {
    if (!TARGET_FIELDS.has(key)) issue(errors, "unknown_target_field", `${path}.${key}`, `Unsupported target field: ${key}`);
  }
  if (typeof target.id !== "string" || !SAFE_ID.test(target.id)) issue(errors, "invalid_target_id", `${path}.id`, "Target ID must be a safe stable identifier.");
  else if (ids.has(target.id)) issue(errors, "duplicate_target_id", `${path}.id`, `Target ID is repeated: ${target.id}`);
  else ids.add(target.id);

  if (typeof target.metric !== "string" || !SAFE_ID.test(target.metric)) issue(errors, "invalid_metric", `${path}.metric`, "Metric must be a safe identifier.");
  if (!SYSTEM_TARGET_PROVENANCE.includes(target.provenance)) issue(errors, "invalid_provenance", `${path}.provenance`, "Target provenance is not supported.");
  if (!CONFIDENCE.has(target.confidence)) issue(errors, "invalid_confidence", `${path}.confidence`, "Confidence must be high, medium, or low.");
  if (typeof target.rationale !== "string" || !target.rationale.trim()) issue(errors, "missing_rationale", `${path}.rationale`, "Target rationale is required.");

  const status = target.status;
  if (status !== "resolved" && status !== "unresolved") issue(errors, "invalid_target_status", `${path}.status`, "Target status must be resolved or unresolved.");
  if (status === "unresolved") {
    if ("value" in target || "unit" in target || "condition" in target) issue(errors, "unresolved_target_has_value", path, "An unresolved target cannot contain a value, unit, or boundary condition.");
    return;
  }
  if ("value" in target && (typeof target.value !== "number" || !Number.isFinite(target.value) || target.value < 0)) issue(errors, "invalid_value", `${path}.value`, "Target value must be a finite non-negative number.");
  const hasValue = typeof target.value === "number" && Number.isFinite(target.value);
  const hasUnit = typeof target.unit === "string" && Boolean(target.unit.trim());
  const hasCondition = typeof target.condition === "string" && Boolean(target.condition.trim());
  if (group === "architecture_boundary") {
    if (hasCondition === (hasValue && hasUnit)) issue(errors, "invalid_boundary", path, "A boundary must have either value and unit or one observable condition.");
    if (hasValue && !hasUnit) issue(errors, "missing_unit", `${path}.unit`, "Numeric target value requires a unit.");
    if (hasUnit && !hasValue) issue(errors, "missing_value", `${path}.value`, "A unit requires a numeric target value.");
  } else {
    if (!hasValue) issue(errors, "missing_value", `${path}.value`, "Resolved initial and growth targets require a numeric value.");
    if (!hasUnit) issue(errors, "missing_unit", `${path}.unit`, "Resolved initial and growth targets require a unit.");
    if (hasCondition) issue(errors, "condition_not_allowed", `${path}.condition`, "Observable conditions are only valid for architecture boundaries.");
  }
}

export function validateSystemTargets(targets) {
  const errors = [];
  if (!isRecord(targets)) return { valid: false, errors: [{ code: "invalid_document", path: "$", message: "System Targets must be an object." }] };
  for (const key of Object.keys(targets)) {
    if (!ROOT_FIELDS.has(key)) issue(errors, "unknown_field", `$.${key}`, `Unsupported System Targets field: ${key}`);
  }
  if (targets.schema_version !== 1) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 1.");
  if (targets.id !== "system-targets") issue(errors, "invalid_document_id", "$.id", "System Targets id must be system-targets.");

  if (!isRecord(targets.system_characteristics)) {
    issue(errors, "invalid_characteristics", "$.system_characteristics", "System Characteristics must be an object.");
  } else {
    for (const key of Object.keys(targets.system_characteristics)) {
      if (!SYSTEM_CHARACTERISTIC_IDS.includes(key)) issue(errors, "unknown_characteristic", `$.system_characteristics.${key}`, `Unsupported System Characteristic: ${key}`);
    }
    for (const key of SYSTEM_CHARACTERISTIC_IDS) {
      if (typeof targets.system_characteristics[key] !== "string" || !targets.system_characteristics[key].trim()) {
        issue(errors, "missing_characteristic", `$.system_characteristics.${key}`, `System Characteristic ${key} must be described.`);
      }
    }
  }

  const ids = new Set();
  for (const group of SYSTEM_TARGET_GROUPS) {
    if (!Array.isArray(targets[group])) {
      issue(errors, "invalid_target_group", `$.${group}`, `${group} must be a list; use an empty list when no related targets apply.`);
      continue;
    }
    targets[group].forEach((target, index) => validateMetric(target, `$.${group}[${index}]`, group, errors, ids));
  }
  return { valid: errors.length === 0, errors };
}
