import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { computeApprovalHash, verifyApproval } from "./approval.mjs";
import { JsonlEventWriter, replayEventStream } from "../eval/journal.mjs";
import { isWithin } from "../eval/util.mjs";
import { REVIEW_CHECKLIST_ITEMS, validateArchitectureDecision, validateReviewRecord } from "./validation.mjs";

const SAFE_REVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVIEW_MODES = new Set(["Learning", "Normal"]);
const MATERIAL_RESULTS = new Set(["approved", "rejected"]);

function requireSafeReviewId(value, label) {
  if (typeof value !== "string" || !SAFE_REVIEW_ID.test(value)) throw new TypeError(`${label} must be a safe identifier`);
  return value;
}

function requireMaterial(material) {
  if (!material || typeof material !== "object" || Array.isArray(material)) throw new TypeError("material must be an object");
  if (Object.keys(material).some((key) => !["id", "source_ids", "claim_ids", "context", "provenance"].includes(key))) throw new TypeError("material contains unsupported fields");
  requireSafeReviewId(material.id, "material.id");
  for (const field of ["source_ids", "claim_ids"]) {
    if (!Array.isArray(material[field]) || material[field].length === 0 || material[field].some((id) => typeof id !== "string" || !SAFE_REVIEW_ID.test(id)) || new Set(material[field]).size !== material[field].length) {
      throw new TypeError(`material.${field} must contain safe source or claim identifiers`);
    }
  }
  for (const field of ["context", "provenance"]) {
    if (typeof material[field] !== "string" || !material[field].trim()) throw new TypeError(`material.${field} is required`);
  }
}

export function createReviewSession({ session_id, mode = "Learning", actor = null, explicit = true, at = new Date().toISOString(), unresolved_gates = [] } = {}) {
  requireSafeReviewId(session_id, "session_id");
  if (!REVIEW_MODES.has(mode)) throw new TypeError("mode must be Learning or Normal");
  if (!Array.isArray(unresolved_gates) || unresolved_gates.some((gateId) => typeof gateId !== "string" || !SAFE_REVIEW_ID.test(gateId))) {
    throw new TypeError("unresolved_gates must be a list of safe gate identifiers");
  }
  const history = [];
  if (mode === "Normal") {
    if (explicit !== true) throw new TypeError("Normal mode must be explicitly selected by the user");
    if (!actor || actor.role !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new TypeError("Normal mode requires an explicit user choice");
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new TypeError("mode selection timestamp must be valid");
    history.push({ type: "mode_selected", mode: "Normal", actor: actor.id, at });
  }
  return { session_id, mode, unresolved_gates: [...new Set(unresolved_gates)], history, pending_material_approval: null };
}

export function transitionReviewMode(session, { to, actor, explicit = true, at = new Date().toISOString() } = {}) {
  if (!session || typeof session !== "object" || !REVIEW_MODES.has(session.mode)) throw new TypeError("session has an invalid mode");
  if (!REVIEW_MODES.has(to)) throw new TypeError("mode must be Learning or Normal");
  if (explicit !== true) throw new TypeError("mode transition must be explicit");
  if (!actor || actor.role !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new TypeError("mode transition requires an explicit user choice");
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new TypeError("mode transition timestamp must be valid");
  if (to === session.mode) return structuredClone(session);
  const event = { type: "mode_changed", from: session.mode, to, actor: actor.id, at };
  return { ...structuredClone(session), mode: to, history: [...(session.history ?? []), event] };
}

export function recordMaterialApproval(material, actor, result) {
  requireMaterial(material);
  if (!actor || actor.role !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new TypeError("material use approval requires a user decision");
  if (!MATERIAL_RESULTS.has(result)) throw new TypeError("result must be approved or rejected");
  return {
    schema_version: 1,
    id: `${material.id}-use-approval`,
    material_id: material.id,
    source_ids: [...material.source_ids],
    claim_ids: [...material.claim_ids],
    context: material.context,
    provenance: material.provenance,
    result,
    decided_by_role: "user",
    decided_by: actor.id,
    decided_at: new Date().toISOString(),
    subject_hash: computeApprovalHash(material),
  };
}

export function canReviewerUseMaterial(material, approval) {
  try {
    requireMaterial(material);
    return Boolean(
      approval && approval.schema_version === 1 && approval.material_id === material.id &&
      approval.id === `${material.id}-use-approval` && approval.result === "approved" && approval.decided_by_role === "user" &&
      typeof approval.decided_by === "string" && approval.decided_by.trim() &&
      typeof approval.decided_at === "string" && !Number.isNaN(Date.parse(approval.decided_at)) &&
      approval.subject_hash === computeApprovalHash(material) &&
      JSON.stringify(approval.source_ids) === JSON.stringify(material.source_ids) &&
      JSON.stringify(approval.claim_ids) === JSON.stringify(material.claim_ids) &&
      approval.context === material.context && approval.provenance === material.provenance,
    );
  } catch {
    return false;
  }
}

export function validateMaterialApprovalRecord(approval) {
  const allowed = new Set(["schema_version", "id", "material_id", "source_ids", "claim_ids", "context", "provenance", "result", "decided_by_role", "decided_by", "decided_at", "subject_hash"]);
  if (!approval || typeof approval !== "object" || Array.isArray(approval) || Object.keys(approval).some((key) => !allowed.has(key))) return { valid: false, errors: [{ code: "invalid_material_approval", path: "$", message: "Material approval contains unsupported fields." }] };
  if (approval.schema_version !== 1 || typeof approval.id !== "string" || !SAFE_REVIEW_ID.test(approval.id) || typeof approval.material_id !== "string" || !SAFE_REVIEW_ID.test(approval.material_id)) return { valid: false, errors: [{ code: "invalid_material_approval", path: "$.id", message: "Material approval identity is invalid." }] };
  if (!MATERIAL_RESULTS.has(approval.result) || approval.decided_by_role !== "user" || typeof approval.decided_by !== "string" || !approval.decided_by.trim() || typeof approval.decided_at !== "string" || Number.isNaN(Date.parse(approval.decided_at)) || !/^[a-f0-9]{64}$/.test(approval.subject_hash ?? "")) return { valid: false, errors: [{ code: "invalid_material_approval", path: "$.result", message: "Material approval decision or hash is invalid." }] };
  const material = { id: approval.material_id, source_ids: approval.source_ids, claim_ids: approval.claim_ids, context: approval.context, provenance: approval.provenance };
  try {
    requireMaterial(material);
  } catch (error) {
    return { valid: false, errors: [{ code: "invalid_material_approval", path: "$.material_id", message: error.message }] };
  }
  if (approval.id !== `${material.id}-use-approval`) return { valid: false, errors: [{ code: "invalid_material_approval", path: "$.id", message: "Material approval ID does not match its material." }] };
  const valid = approval.subject_hash === computeApprovalHash(material);
  return { valid, errors: valid ? [] : [{ code: "material_approval_hash_mismatch", path: "$.subject_hash", message: "Material approval does not match the exact presented material." }] };
}

export function materialApprovalReferences(review) {
  if (Array.isArray(review?.material_approvals)) return review.material_approvals.map((reference) => reference?.approval_id).filter((id) => typeof id === "string");
  return typeof review?.material_approval?.approval_id === "string" ? [review.material_approval.approval_id] : [];
}

function reviewJournalPath(root, sessionId) {
  const safeId = requireSafeReviewId(sessionId, "sessionId");
  const repositoryRoot = resolve(root);
  const path = resolve(repositoryRoot, join("docs", "specs", ".runtime", "506", safeId, "events.jsonl"));
  if (!isWithin(repositoryRoot, path)) throw new TypeError("review journal path escapes the project root");
  return { repositoryRoot, path };
}

async function assertReviewPathContained(repositoryRoot, path) {
  const rootPath = await realpath(repositoryRoot);
  if (!isWithin(rootPath, path)) throw new TypeError("review journal path escapes the project root");
  const fileInfo = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (fileInfo?.isSymbolicLink() || (fileInfo && !fileInfo.isFile())) throw new TypeError("review journal must be a regular file");
  let current = dirname(path);
  while (isWithin(rootPath, current) && current !== rootPath) {
    const info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new TypeError("review journal path cannot pass through a symlink");
    current = dirname(current);
  }
}

export async function appendReviewHistory({ root = process.cwd(), session, type, approval_id, subject_hash, event } = {}) {
  if (!session || typeof session !== "object") throw new TypeError("session is required");
  requireSafeReviewId(session.session_id, "session.session_id");
  if (!REVIEW_MODES.has(session.mode)) throw new TypeError("session has an invalid mode");
  if (typeof type !== "string" || !["session_started", "mode_changed", "material_approval_requested", "material_use_decided", "review_outcome_recorded", "resume"].includes(type)) {
    throw new TypeError("unsupported review history event");
  }
  const { repositoryRoot, path } = reviewJournalPath(root, session.session_id);
  await mkdir(dirname(path), { recursive: true });
  await assertReviewPathContained(repositoryRoot, path);
  const streamId = `decision-review-${session.session_id}`;
  const writer = await new JsonlEventWriter(path, { streamId }).init();
  try {
    const payload = {
      session_id: session.session_id,
      mode: session.mode,
      unresolved_gates: [...(session.unresolved_gates ?? [])],
      type,
      ...(type === "material_approval_requested" ? { approval_id, subject_hash } : {}),
      ...(type === "material_use_decided" && event ? { approval_id: event.approval_id, result: event.result } : {}),
      ...(event ? { event: structuredClone(event) } : {}),
    };
    await writer.append("decision_review_history", payload, { critical: true });
  } finally {
    await writer.close();
  }
  return path;
}

export async function resumeReviewSession({ root = process.cwd(), sessionId } = {}) {
  const { repositoryRoot, path } = reviewJournalPath(root, sessionId);
  await assertReviewPathContained(repositoryRoot, path);
  const streamId = `decision-review-${sessionId}`;
  const replay = await replayEventStream(path, { streamId });
  if (replay.corruption) throw new TypeError(`review history is corrupt: ${replay.corruption.kind}`);
  if (replay.events.length === 0) throw new TypeError(`review history is missing for ${sessionId}`);
  const history = [];
  let state = null;
  let pendingMaterialApproval = null;
  for (const envelope of replay.events) {
    if (envelope.type !== "decision_review_history" || envelope.payload.session_id !== sessionId) throw new TypeError("review history contains an invalid event");
    const payload = envelope.payload;
    state = { session_id: sessionId, mode: payload.mode, unresolved_gates: [...payload.unresolved_gates] };
    history.push({ type: payload.type, ...(payload.event ?? {}) });
    if (payload.type === "material_approval_requested") pendingMaterialApproval = { approval_id: payload.approval_id, subject_hash: payload.subject_hash };
    if (payload.type === "material_use_decided") pendingMaterialApproval = null;
  }
  return { ...state, history, pending_material_approval: pendingMaterialApproval };
}

function gate(status, ruleId, reason, evidencePath, violations = []) {
  return { status, rule_id: ruleId, reason, evidence_path: evidencePath, violations };
}

export function evaluateDecisionGate(decision, targets, review, refs = {}) {
  const targetIds = [...(targets?.initial ?? []), ...(targets?.expected_growth ?? []), ...(targets?.architecture_boundary ?? [])].map((target) => target.id);
  const evidencePath = decision?.id ? `docs/specs/architecture-decisions/${decision.id}.yaml` : "docs/specs/architecture-decisions/";
  const errors = validateArchitectureDecision(decision, { targetIds, ...refs }).errors;
  if (errors.length) {
    return {
      decision_evidence_complete: gate("fail", "decision_evidence_complete", "Architecture Decision structure or references are invalid.", evidencePath, errors),
      decision_review_complete: gate("blocked", "decision_review_complete", "Review cannot pass before its decision is valid.", evidencePath),
    };
  }
  if (decision.status !== "accepted") {
    const waiting = gate("blocked", "decision_evidence_complete", `Decision ${decision.id} is not accepted.`, evidencePath);
    return { decision_evidence_complete: waiting, decision_review_complete: gate("blocked", "decision_review_complete", "Decision must be accepted before review can pass.", evidencePath) };
  }
  const approval = verifyApproval(decision, decision.approval);
  if (!approval.valid) {
    const invalid = gate("fail", "decision_evidence_complete", `Decision ${decision.id} approval is invalid.`, evidencePath, approval.errors);
    return { decision_evidence_complete: invalid, decision_review_complete: gate("blocked", "decision_review_complete", "Decision approval is invalid.", evidencePath) };
  }

  const evidence = gate("pass", "decision_evidence_complete", "Architecture Decision and its own approval are valid.", evidencePath);
  const reviewPath = decision.review_id ? `docs/specs/architecture-reviews/${decision.review_id}.yaml` : "docs/specs/architecture-reviews/";
  if (!review) return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "Decision ReviewRecord is missing.", reviewPath) };
  const reviewValidation = validateReviewRecord(review, { decisionIds: [decision.id], targetIds, ...refs });
  if (!reviewValidation.valid) return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "Decision ReviewRecord is invalid.", reviewPath, reviewValidation.errors) };
  if (review.id !== decision.review_id || review.decision_id !== decision.id) return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "ReviewRecord does not match the decision reference.", reviewPath) };
  const materialIds = review.material_ids ?? [];
  if (materialIds.length > 0) {
    const approvalIds = materialApprovalReferences(review);
    const approvals = approvalIds.map((approvalId) => refs.materialApprovals?.[approvalId]);
    if (approvalIds.length === 0 || approvals.some((approval) => !approval || approval.result !== "approved")) {
      return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "Reviewer material use is waiting for explicit user approval.", reviewPath, [{ code: "material_use_approval_required", path: "$.material_approval", message: "Every new material used by Reviewer needs an approved material-use record." }]) };
    }
    const approvedMaterialIds = approvals.map((approval) => approval.material_id);
    if (new Set(approvedMaterialIds).size !== approvedMaterialIds.length || approvedMaterialIds.some((materialId) => !materialIds.includes(materialId))) {
      return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "Material approval references do not match the materials used by Reviewer.", reviewPath, [{ code: "material_approval_ref_mismatch", path: "$.material_ids", message: "Review material IDs must exactly match the material approval records." }]) };
    }
    if (approvedMaterialIds.length !== materialIds.length) {
      return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "At least one Reviewer material has no user approval.", reviewPath, [{ code: "uncovered_material", path: "$.material_ids", message: "Each material ID must have its own approved material-use record." }]) };
    }
    for (const materialApproval of approvals) {
      const material = { id: materialApproval.material_id, source_ids: materialApproval.source_ids, claim_ids: materialApproval.claim_ids, context: materialApproval.context, provenance: materialApproval.provenance };
      if (!canReviewerUseMaterial(material, materialApproval)) {
        return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "Material approval does not match the exact content presented to the user.", reviewPath, [{ code: "material_approval_hash_mismatch", path: "$.material_approvals", message: "Material must be re-presented and approved after its content changes." }]) };
      }
    }
  }
  if (review.outcome !== "ACCEPTED" || REVIEW_CHECKLIST_ITEMS.some((item) => review.checklist[item] !== true) || review.objections.some((objection) => objection.status === "open")) {
    return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "Review outcome, checklist, or objection state is unresolved.", reviewPath) };
  }
  return { decision_evidence_complete: evidence, decision_review_complete: gate("pass", "decision_review_complete", "ReviewRecord is accepted with all seven checklist items and no open objections.", reviewPath) };
}
