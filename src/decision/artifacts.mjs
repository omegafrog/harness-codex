import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseYaml } from "../eval/yaml.mjs";
import { isWithin } from "../eval/util.mjs";
import { validateArchitectureDecision, validateReviewRecord, validateSystemTargets } from "./validation.mjs";
import { validateMaterialApprovalRecord } from "./review.mjs";
import { readEvidence, readPrinciple } from "../knowledge/registry.mjs";

const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function artifactPath(root, ticketId) {
  if (typeof ticketId !== "string" || !SAFE_TICKET_ID.test(ticketId)) throw new TypeError("ticketId must be a safe ticket identifier");
  const path = resolve(root, join("docs", "specs", ticketId, "system-targets.yaml"));
  if (!isWithin(root, path)) throw new TypeError("system target artifact path escapes the project root");
  return path;
}

function decisionArtifactPath(root, ticketId, directory, id) {
  if (typeof ticketId !== "string" || !SAFE_TICKET_ID.test(ticketId)) throw new TypeError("ticketId must be a safe ticket identifier");
  if (typeof id !== "string" || !SAFE_TICKET_ID.test(id)) throw new TypeError("artifact id must be a safe identifier");
  const path = resolve(root, join("docs", "specs", ticketId, directory, `${id}.yaml`));
  if (!isWithin(root, path)) throw new TypeError("decision artifact path escapes the project root");
  return path;
}

async function assertContainedNoSymlinks(root, path) {
  const rootPath = await realpath(root);
  if (!isWithin(rootPath, path)) throw new TypeError("system target artifact path escapes the project root");
  let current = dirname(path);
  while (isWithin(rootPath, current) && current !== rootPath) {
    const info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new TypeError("system target artifact path cannot pass through a symlink");
    current = dirname(current);
  }
}

function validate(targets) {
  const result = validateSystemTargets(targets);
  if (!result.valid) {
    const first = result.errors[0];
    const error = new TypeError(`${first.path}: ${first.message}`);
    error.validation = result;
    throw error;
  }
}

function validateObject(result, label) {
  if (!result.valid) {
    const first = result.errors[0];
    const error = new TypeError(`${first.path}: ${first.message}`);
    error.validation = result;
    throw error;
  }
  return result;
}

async function readYamlArtifact(root, path, validateFn) {
  await assertContainedNoSymlinks(root, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("decision artifact must be a regular file");
  const value = parseYaml(await readFile(path, "utf8"));
  validateFn(value);
  return value;
}

async function writeYamlArtifact(root, path, value, validateFn) {
  validateFn(value);
  await assertContainedNoSymlinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  await assertContainedNoSymlinks(root, path);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError("decision artifact must be a regular file");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { path, value };
}

export async function readSystemTargets({ root = process.cwd(), ticketId }) {
  const path = artifactPath(root, ticketId);
  await assertContainedNoSymlinks(root, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("system target artifact must be a regular file");
  const targets = parseYaml(await readFile(path, "utf8"));
  validate(targets);
  return targets;
}

export async function writeSystemTargets(options = {}) {
  const { root = process.cwd(), ticketId, targets } = options;
  if ("path" in options) throw new TypeError("system target artifact path is not configurable");
  validate(targets);
  const path = artifactPath(root, ticketId);
  await assertContainedNoSymlinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  await assertContainedNoSymlinks(root, path);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError("system target artifact must be a regular file");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, targets };
}

export async function readArchitectureDecision({ root = process.cwd(), ticketId, decisionId, refs = {} }) {
  const path = decisionArtifactPath(root, ticketId, "architecture-decisions", decisionId);
  return readYamlArtifact(root, path, (value) => {
    if (value?.id !== decisionId) throw artifactIdentityError("decision_id_mismatch", "$.id", `Decision file ${decisionId}.yaml contains a different object ID.`);
    validateObject(validateArchitectureDecision(value, refs), "Architecture Decision");
  });
}

export async function writeArchitectureDecision(options = {}) {
  const { root = process.cwd(), ticketId, decision, refs = {} } = options;
  if ("path" in options) throw new TypeError("decision artifact path is not configurable");
  const path = decisionArtifactPath(root, ticketId, "architecture-decisions", decision?.id);
  return writeYamlArtifact(root, path, decision, (value) => validateObject(validateArchitectureDecision(value, refs), "Architecture Decision"));
}

export async function readReviewRecord({ root = process.cwd(), ticketId, reviewId, refs = {} }) {
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews", reviewId);
  return readYamlArtifact(root, path, (value) => {
    if (value?.id !== reviewId) throw artifactIdentityError("review_id_mismatch", "$.id", `Review file ${reviewId}.yaml contains a different object ID.`);
    validateObject(validateReviewRecord(value, refs), "Review Record");
  });
}

export async function writeReviewRecord(options = {}) {
  const { root = process.cwd(), ticketId, review, refs = {} } = options;
  if ("path" in options) throw new TypeError("review artifact path is not configurable");
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews", review?.id);
  return writeYamlArtifact(root, path, review, (value) => validateObject(validateReviewRecord(value, refs), "Review Record"));
}

export async function readMaterialApproval({ root = process.cwd(), ticketId, approvalId }) {
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews/material-approvals", approvalId);
  return readYamlArtifact(root, path, (value) => {
    if (value?.id !== approvalId) throw artifactIdentityError("material_approval_id_mismatch", "$.id", `Material approval file ${approvalId}.yaml contains a different object ID.`);
    const validation = validateMaterialApprovalRecord(value);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw artifactValidationError(first.code, first.path, first.message);
    }
  });
}

export async function writeMaterialApproval({ root = process.cwd(), ticketId, approval }) {
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews/material-approvals", approval?.id);
  return writeYamlArtifact(root, path, approval, (value) => {
    const validation = validateMaterialApprovalRecord(value);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw artifactValidationError(first.code, first.path, first.message);
    }
  });
}

function artifactIdentityError(code, path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.validation = { valid: false, errors: [{ code, path, message }] };
  return error;
}

function artifactValidationError(code, path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.validation = { valid: false, errors: [{ code, path, message }] };
  return error;
}

export async function validateEvidenceReferences({ root = process.cwd(), evidenceIds = [] }) {
  return resolveKnowledgeReferences({ root, referenceIds: evidenceIds, directory: "evidence", label: "Evidence", field: "evidence_ids", readObject: async (id) => {
    const evidence = await readEvidence({ root, evidenceId: id });
    if (evidence.execution_purpose === "code_validation") throw artifactValidationError("code_validation_not_decision_evidence", "$.execution_purpose", "Code validation Evidence can only be used as code-validation history, not as evidence for an Architecture Decision.");
    return evidence;
  } });
}

export async function validatePrincipleReferences({ root = process.cwd(), principleIds = [], approvedOnly = false }) {
  return resolveKnowledgeReferences({ root, referenceIds: principleIds, directory: "principles", label: "Principle", field: "principle_ids", readObject: async (id) => {
    const principle = await readPrinciple({ root, principleId: id });
    if (approvedOnly && principle.status !== "approved") {
      const code = principle.status === "deprecated" ? "deprecated_principle_review_required" : "unapproved_principle_reference";
      const message = principle.status === "deprecated" ? "A deprecated Principle requires its referencing Decision to be reviewed." : "Only an approved Principle can be used as authoritative Decision evidence.";
      throw artifactValidationError(code, "$.status", message);
    }
    return principle;
  } });
}

async function resolveKnowledgeReferences({ root, referenceIds, directory, label, field, readObject }) {
  const resolved = [];
  for (const id of referenceIds) {
    if (typeof id !== "string" || !SAFE_TICKET_ID.test(id)) {
      const error = new TypeError(`${label} reference ID must be a safe identifier.`);
      error.validation = { valid: false, errors: [{ code: `invalid_${label.toLowerCase()}_ref`, path: `$.${field}`, message: error.message }] };
      throw error;
    }
    const path = resolve(root, "knowledge", directory, `${id}.yaml`);
    if (!isWithin(root, path)) throw new TypeError(`${label} reference path escapes the project root`);
    const record = await readObject(id);
    resolved.push(record.id);
  }
  return resolved;
}
