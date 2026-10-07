import { createHash } from "node:crypto";

const META_FIELDS = new Set(["approval", "status", "history", "review_required", "review_status", "review_flags", "derived_review_flags"]);

function canonicalize(value, topLevel = false) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !topLevel || !META_FIELDS.has(key)).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function computeApprovalHash(substantiveObject) {
  if (!substantiveObject || typeof substantiveObject !== "object" || Array.isArray(substantiveObject)) throw new TypeError("approval subject must be an object");
  return createHash("sha256").update(JSON.stringify(canonicalize(substantiveObject, true))).digest("hex");
}

export function verifyApproval(object, approval) {
  const errors = [];
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    errors.push({ code: "missing_approval", path: "$.approval", message: "Approval record is required." });
  } else {
    for (const key of Object.keys(approval)) if (!["approver", "approved_at", "subject_hash"].includes(key)) errors.push({ code: "unknown_approval_field", path: `$.approval.${key}`, message: `Unsupported approval field: ${key}` });
    if (typeof approval.approver !== "string" || !approval.approver.trim()) errors.push({ code: "missing_approver", path: "$.approval.approver", message: "Approval approver is required." });
    if (typeof approval.approved_at !== "string" || !Number.isFinite(Date.parse(approval.approved_at))) errors.push({ code: "invalid_approval_timestamp", path: "$.approval.approved_at", message: "Approval timestamp must be a valid date." });
    if (!/^[a-f0-9]{64}$/.test(approval.subject_hash ?? "")) errors.push({ code: "invalid_approval_hash", path: "$.approval.subject_hash", message: "Approval hash must be a SHA-256 hex digest." });
    else if (approval.subject_hash !== computeApprovalHash(object)) errors.push({ code: "approval_hash_mismatch", path: "$.approval.subject_hash", message: "Substantive object content changed after approval." });
  }
  return { valid: errors.length === 0, errors };
}
