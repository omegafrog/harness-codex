import { SYSTEM_CHARACTERISTIC_IDS, SYSTEM_TARGET_GROUPS, SYSTEM_TARGET_METRICS } from "./model.mjs";
import { verifyApproval } from "./approval.mjs";

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
ROOT_FIELDS.add("decision_metadata");

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

  if (typeof target.metric !== "string" || !SYSTEM_TARGET_METRICS.includes(target.metric)) issue(errors, "invalid_metric", `${path}.metric`, "Metric must be one of the supported System Target metrics.");
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
  if ("condition" in target && (typeof target.condition !== "string" || !target.condition.trim())) issue(errors, "invalid_condition", `${path}.condition`, "Boundary condition must be non-empty text.");
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
  if (targets.decision_metadata !== undefined) {
    const metadata = targets.decision_metadata;
    if (!isRecord(metadata) || Object.keys(metadata).some((key) => !["decision_layer_version", "decision_ids"].includes(key))) {
      issue(errors, "invalid_decision_metadata", "$.decision_metadata", "Decision metadata must contain only decision_layer_version and decision_ids.");
    } else if (metadata.decision_layer_version !== 2) {
      issue(errors, "invalid_decision_layer_version", "$.decision_metadata.decision_layer_version", "decision_layer_version must be 2 when decision metadata is present.");
    } else if (!Array.isArray(metadata.decision_ids) || metadata.decision_ids.length === 0 || metadata.decision_ids.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) || new Set(metadata.decision_ids).size !== metadata.decision_ids.length) {
      issue(errors, "invalid_decision_ids", "$.decision_metadata.decision_ids", "Decision IDs must be a non-empty list of unique safe identifiers.");
    }
  }
  return { valid: errors.length === 0, errors };
}

const DECISION_FIELDS = new Set(["schema_version", "id", "status", "category", "problem", "constraints", "requirement_ids", "target_ids", "options", "selected_option", "rejected_alternatives", "rationale", "tradeoffs", "principle_ids", "evidence_ids", "boundary", "approval", "review_id", "review_mode", "history", "review_required", "review_status", "review_flags", "criteria", "evaluations", "selection", "single_option_reason"]);
const REVIEW_OUTCOMES = new Set(["ACCEPTED", "NEEDS_DEFENSE", "NEEDS_EVIDENCE", "NEEDS_REVISION"]);

function validateSafeIdList(value, path, errors, { required = true } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    issue(errors, "invalid_reference_list", path, "Expected a non-empty list of stable identifiers.");
    return;
  }
  const seen = new Set();
  value.forEach((id, index) => {
    if (typeof id !== "string" || !SAFE_ID.test(id)) issue(errors, "invalid_reference_id", `${path}[${index}]`, "Reference ID must be a safe stable identifier.");
    else if (seen.has(id)) issue(errors, "duplicate_reference_id", `${path}[${index}]`, `Reference is repeated: ${id}`);
    else seen.add(id);
  });
}

function knownReferences(values, available, path, code, errors) {
  if (available === undefined) return;
  const ids = new Set(Array.isArray(available) ? available : Object.keys(available));
  for (const [index, id] of values.entries()) if (!ids.has(id)) issue(errors, code, `${path}[${index}]`, `Unknown reference: ${id}`);
}

export function validateArchitectureDecision(decision, refs = {}, { checkApproval = true } = {}) {
  const errors = [];
  if (!isRecord(decision)) return { valid: false, errors: [{ code: "invalid_decision", path: "$", message: "Architecture Decision must be an object." }] };
  for (const key of Object.keys(decision)) if (!DECISION_FIELDS.has(key)) issue(errors, "unknown_decision_field", `$.${key}`, `Unsupported decision field: ${key}`);
  if (decision.review_required !== undefined && typeof decision.review_required !== "boolean") issue(errors, "invalid_review_required", "$.review_required", "review_required must be a boolean.");
  if (decision.review_flags !== undefined && (!Array.isArray(decision.review_flags) || decision.review_flags.some((flag) => typeof flag !== "string" || !flag.trim()) || new Set(decision.review_flags).size !== decision.review_flags.length)) issue(errors, "invalid_review_flags", "$.review_flags", "review_flags must be a unique list of non-empty strings.");
  if (decision.schema_version !== 2) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 2.");
  if (typeof decision.id !== "string" || !SAFE_ID.test(decision.id)) issue(errors, "invalid_decision_id", "$.id", "Decision ID must be a safe stable identifier.");
  if (!["code", "infrastructure"].includes(decision.category)) issue(errors, "invalid_decision_category", "$.category", "Decision category must be code or infrastructure.");
  for (const field of ["problem", "rationale", "boundary"]) if (typeof decision[field] !== "string" || !decision[field].trim()) issue(errors, `missing_${field}`, `$.${field}`, `${field} is required.`);
  for (const field of ["constraints", "requirement_ids", "target_ids", "options", "tradeoffs"]) {
    if (!Array.isArray(decision[field]) || decision[field].length === 0) issue(errors, `missing_${field}`, `$.${field}`, `${field} must be a non-empty list.`);
  }
  for (const field of ["requirement_ids", "target_ids"]) validateSafeIdList(decision[field], `$.${field}`, errors);
  validateSafeIdList(decision.evidence_ids ?? [], "$.evidence_ids", errors, { required: false });
  validateSafeIdList(decision.principle_ids ?? [], "$.principle_ids", errors, { required: false });
  if (Array.isArray(decision.options)) {
    const optionIds = new Set();
    for (const [index, option] of decision.options.entries()) {
      if (!isRecord(option) || typeof option.id !== "string" || !SAFE_ID.test(option.id) || typeof option.description !== "string" || !option.description.trim()) issue(errors, "invalid_decision_option", `$.options[${index}]`, "Each option needs a stable id and description.");
      else if (Object.keys(option).some((key) => !["id", "description"].includes(key))) issue(errors, "unknown_decision_option_field", `$.options[${index}]`, "Decision options contain unsupported fields.");
      else if (optionIds.has(option.id)) issue(errors, "duplicate_option_id", `$.options[${index}].id`, `Option is repeated: ${option.id}`);
      else optionIds.add(option.id);
    }
    if (decision.selected_option && !optionIds.has(decision.selected_option)) issue(errors, "unknown_selected_option", "$.selected_option", "Selected option must reference a declared option.");
    if (!decision.selected_option) issue(errors, "missing_selected_option", "$.selected_option", "A selected option is required.");
    const rejected = new Set();
    for (const [index, alternative] of (Array.isArray(decision.rejected_alternatives) ? decision.rejected_alternatives : []).entries()) {
      if (!isRecord(alternative) || !optionIds.has(alternative.option_id) || alternative.option_id === decision.selected_option || typeof alternative.reason !== "string" || !alternative.reason.trim()) issue(errors, "invalid_rejected_alternative", `$.rejected_alternatives[${index}]`, "Rejected alternatives must reference an unselected option and include a reason.");
      else if (Object.keys(alternative).some((key) => !["option_id", "reason"].includes(key))) issue(errors, "unknown_rejected_alternative_field", `$.rejected_alternatives[${index}]`, "Rejected alternative contains unsupported fields.");
      else rejected.add(alternative.option_id);
    }
    for (const id of optionIds) if (id !== decision.selected_option && !rejected.has(id)) issue(errors, "missing_rejected_alternative", "$.rejected_alternatives", `Unselected option ${id} needs a rejection reason.`);
  }
  if (decision.review_id !== undefined && (typeof decision.review_id !== "string" || !SAFE_ID.test(decision.review_id))) issue(errors, "invalid_review_ref", "$.review_id", "ReviewRecord ID must be a stable identifier.");
  if (!["Normal", "Learning"].includes(decision.review_mode)) issue(errors, "invalid_review_mode", "$.review_mode", "Decision review mode must be Normal or Learning.");
  if (decision.review_mode === "Learning" && !decision.review_id) issue(errors, "missing_learning_review", "$.review_id", "Learning mode requires a review record.");
  validateComparison(decision, errors);
  knownReferences(decision.target_ids ?? [], refs.targetIds, "$.target_ids", "unknown_target_ref", errors);
  knownReferences(decision.evidence_ids ?? [], refs.evidenceIds, "$.evidence_ids", "unknown_evidence_ref", errors);
  if (!["proposed", "held", "accepted"].includes(decision.status)) issue(errors, "invalid_decision_status", "$.status", "Decision status must be proposed, held, or accepted.");
  if (decision.status === "accepted" && checkApproval) for (const error of verifyApproval(decision, decision.approval).errors) issue(errors, error.code, error.path, error.message);
  return { valid: errors.length === 0, errors };
}

function validateComparison(decision, errors) {
  const criteria = Array.isArray(decision.criteria) ? decision.criteria : [];
  const options = Array.isArray(decision.options) ? decision.options : [];
  const evaluations = Array.isArray(decision.evaluations) ? decision.evaluations : [];
  const ids = new Set();
  if (!criteria.length) issue(errors, "missing_criteria", "$.criteria", "At least one decision criterion is required.");
  for (const [index, criterion] of criteria.entries()) {
    const path = `$.criteria[${index}]`;
    const problems = criterionProblems(criterion, decision, ids);
    if (problems.length) issue(errors, "invalid_criterion", path, `Criterion ${path} is invalid: ${problems.join("; ")}.`);
    else ids.add(criterion.id);
  }
  if (options.length === 1 && (typeof decision.single_option_reason !== "string" || !decision.single_option_reason.trim())) issue(errors, "missing_single_option_reason", "$.single_option_reason", "Explain why no alternative is available.");
  for (const option of options) for (const criterion of criteria) {
    const optionId = option?.id, criterionId = criterion?.id;
    const matches = evaluations.filter((entry) => entry?.option_id === optionId && entry?.criterion_id === criterionId);
    if (matches.length !== 1) { issue(errors, "missing_evaluation", "$.evaluations", `Exactly one evaluation is required for ${optionId}/${criterionId}.`); continue; }
    const entry = matches[0];
    const problems = evaluationProblems(entry);
    if (problems.length) issue(errors, "invalid_evaluation", `$.evaluations[${evaluations.indexOf(entry)}]`, `Evaluation ${optionId}/${criterionId} is invalid: ${problems.join("; ")}.`);
  }
  if (evaluations.length !== options.length * criteria.length) issue(errors, "unexpected_evaluation", "$.evaluations", "Evaluations must cover exactly the declared options and criteria.");
  const selected = decision.selection;
  const selectionFields = ["decision", "accepted_tradeoffs", "uncertainty", "revisit_when", "user_choice"];
  const selectionProblems = !isRecord(selected) ? ["must be an object"] : [
    ...Object.keys(selected).filter((key) => !selectionFields.includes(key)).map((key) => `unsupported field ${key} (allowed: ${selectionFields.join(", ")})`),
    ...selectionFields.filter((key) => typeof selected[key] !== "string" || !selected[key].trim()).map((key) => `${key} must be a non-empty string`),
  ];
  if (selectionProblems.length) issue(errors, "invalid_selection", "$.selection", `Selection is invalid: ${selectionProblems.join("; ")}. Record the choice, accepted tradeoffs, uncertainty, revisit condition and the user's choice or delegation.`);
}

const CRITERION_FIELDS = ["id", "requirement_id", "condition", "kind", "priority"];
const EVALUATION_FIELDS = ["option_id", "criterion_id", "result", "reason", "evidence_kind", "source", "condition", "checked_at"];
const EVIDENCE_KINDS = ["measured", "external_measurement", "documented", "estimated", "unknown"];
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

// Each problem names the field and the accepted values so an author can fix the YAML in one pass.
function criterionProblems(criterion, decision, ids) {
  if (!isRecord(criterion)) return ["must be an object"];
  const problems = Object.keys(criterion).filter((key) => !CRITERION_FIELDS.includes(key)).map((key) => `unsupported field ${key} (allowed: ${CRITERION_FIELDS.join(", ")})`);
  if (!SAFE_ID.test(criterion.id ?? "")) problems.push("id must be a stable identifier");
  else if (ids.has(criterion.id)) problems.push(`id ${criterion.id} is repeated`);
  if (!Array.isArray(decision.requirement_ids) || !decision.requirement_ids.includes(criterion.requirement_id)) problems.push(`requirement_id ${JSON.stringify(criterion.requirement_id ?? null)} must be one of $.requirement_ids (${(Array.isArray(decision.requirement_ids) ? decision.requirement_ids : []).join(", ") || "none declared"})`);
  if (!nonEmpty(criterion.condition)) problems.push("condition must be a non-empty string");
  if (!["required", "preferred"].includes(criterion.kind)) problems.push("kind must be required or preferred");
  if (!nonEmpty(criterion.priority)) problems.push("priority must be a non-empty string");
  return problems;
}

function evaluationProblems(entry) {
  if (!isRecord(entry)) return ["must be an object"];
  const problems = Object.keys(entry).filter((key) => !EVALUATION_FIELDS.includes(key)).map((key) => `unsupported field ${key} (allowed: ${EVALUATION_FIELDS.join(", ")})`);
  if (!["met", "unmet", "unknown"].includes(entry.result)) problems.push("result must be met, unmet or unknown");
  if (!nonEmpty(entry.reason)) problems.push("reason must be a non-empty string");
  if (!EVIDENCE_KINDS.includes(entry.evidence_kind)) problems.push(`evidence_kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
  if (!nonEmpty(entry.condition)) problems.push("condition must be a non-empty string");
  if (entry.evidence_kind !== "unknown") {
    if (!nonEmpty(entry.source)) problems.push("source is required unless evidence_kind is unknown");
    if (typeof entry.checked_at !== "string" || Number.isNaN(Date.parse(entry.checked_at))) problems.push("checked_at must be an ISO date unless evidence_kind is unknown");
  }
  return problems;
}

export function validateReviewRecord(review, refs = {}) {
  const errors = [];
  if (!isRecord(review)) return { valid: false, errors: [{ code: "invalid_review", path: "$", message: "Review must be an object." }] };
  const fields = ["schema_version", "id", "decision_id", "reviewer", "assessment", "outcome", "findings"];
  for (const key of Object.keys(review)) if (!fields.includes(key)) issue(errors, "unknown_review_field", `$.${key}`, `Unsupported review field: ${key}`);
  if (review.schema_version !== 2) issue(errors, "invalid_schema_version", "$.schema_version", "schema_version must be 2.");
  for (const field of ["id", "decision_id"]) if (typeof review[field] !== "string" || !SAFE_ID.test(review[field])) issue(errors, `invalid_${field}`, `$.${field}`, `${field} must be a stable ID.`);
  for (const field of ["reviewer", "assessment"]) if (typeof review[field] !== "string" || !review[field].trim()) issue(errors, `missing_${field}`, `$.${field}`, `${field} is required.`);
  if (!REVIEW_OUTCOMES.has(review.outcome)) issue(errors, "invalid_review_outcome", "$.outcome", "Unsupported review outcome.");
  if (!Array.isArray(review.findings) || review.findings.some((finding) => !isRecord(finding) || !["blocker", "major", "minor"].includes(finding.severity) || typeof finding.description !== "string" || !finding.description.trim() || typeof finding.evidence !== "string" || !finding.evidence.trim())) issue(errors, "invalid_findings", "$.findings", "Findings require severity, description and evidence.");
  knownReferences([review.decision_id].filter((id) => typeof id === "string"), refs.decisionIds, "$.decision_id", "unknown_decision_ref", errors);
  return { valid: errors.length === 0, errors };
}
