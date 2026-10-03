import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isWithin } from "../eval/util.mjs";
import { parseYaml } from "../eval/yaml.mjs";
import { createEvidence, EVIDENCE_EXECUTION_STATUSES, EVIDENCE_MEASUREMENT_VALIDITIES, EVIDENCE_TYPES } from "./model.mjs";
import { writeEvidence } from "./registry.mjs";
import { computeEvidenceApprovalHash, inspectEvidenceText, isValidTimestamp, validateEvidence } from "./validation.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STAGING_RELATIVE = ["docs", "specs", ".runtime", "506-06-local-evidence", "evidence"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  const normalized = value.trim();
  const inspection = inspectEvidenceText(normalized);
  if (inspection.invalid) throw new TypeError(`${label} must be bounded, single-line normalized text.`);
  if (inspection.forbidden) throw new TypeError(`${label} contains recognized credentials or raw runtime material.`);
  return normalized;
}

function safeEnvironment(value) {
  if (!isRecord(value)) throw new TypeError("Evidence environment must be an object.");
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|password|credential|stdout|journal|checkpoint|history/i.test(key)).map(([key, item]) => [key, requiredText(item, `environment.${key}`)]));
}

function safeObservations(value) {
  if (!Array.isArray(value)) throw new TypeError("Evidence observations must be an array.");
  return value.map((observation, index) => {
    if (!isRecord(observation)) throw new TypeError(`observations[${index}] must be an object.`);
    const result = {
      metric: requiredText(observation.metric, `observations[${index}].metric`),
      value: observation.value,
      unit: requiredText(observation.unit, `observations[${index}].unit`),
    };
    if (typeof result.value === "string") result.value = requiredText(result.value, `observations[${index}].value`);
    if (!(typeof result.value === "number" && Number.isFinite(result.value)) && !(typeof result.value === "string" && result.value)) throw new TypeError(`observations[${index}].value must be finite numeric data or non-empty text.`);
    if (observation.context !== undefined) result.context = requiredText(observation.context, `observations[${index}].context`);
    return result;
  });
}

export function normalizeEvidence(input) {
  if (!isRecord(input)) throw new TypeError("Evidence input must be an object.");
  const execution_status = input.execution_status;
  if (!EVIDENCE_EXECUTION_STATUSES.includes(execution_status)) throw new TypeError("Evidence execution_status is not supported.");
  let measurement_validity = input.measurement_validity;
  if (!EVIDENCE_MEASUREMENT_VALIDITIES.includes(measurement_validity)) throw new TypeError("Evidence measurement_validity is not supported.");
  if (execution_status !== "completed") measurement_validity = "invalid";
  const evidence = createEvidence({
    id: input.id,
    origin_project: requiredText(input.origin_project, "origin_project"),
    environment: safeEnvironment(input.environment),
    timestamp: input.timestamp,
    type: input.type,
    execution_status,
    measurement_validity,
    observations: safeObservations(input.observations),
    source_reference: requiredText(input.source_reference, "source_reference"),
    ...(input.execution_purpose !== undefined ? { execution_purpose: input.execution_purpose } : {}),
    decision_ids: Array.isArray(input.decision_ids) ? input.decision_ids.map((id, index) => requiredText(id, `decision_ids[${index}]`)) : input.decision_ids,
  });
  if (!EVIDENCE_TYPES.includes(evidence.type)) throw new TypeError("Evidence type is not supported.");
  const result = validateEvidence({ ...evidence, summary: "summary validation placeholder" });
  if (!result.valid) throw new TypeError(result.errors.map(({ code, path }) => `${code} at ${path}`).join("; "));
  return evidence;
}

function stageDirectory(root) {
  return resolve(root, ...STAGING_RELATIVE);
}

function artifactPath(directory, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new TypeError("Evidence ID must be a safe stable identifier.");
  const path = resolve(directory, `${id}.yaml`);
  if (!isWithin(directory, path)) throw new TypeError("Evidence path escapes its artifact directory.");
  return path;
}

async function ensureSafeDirectory(root, directory) {
  const rootPath = await realpath(root);
  if (!isWithin(rootPath, directory)) throw new TypeError("Evidence artifact path escapes the project root.");
  let cursor = rootPath;
  for (const part of directory.slice(rootPath.length).split(/[\\/]/).filter(Boolean)) {
    cursor = resolve(cursor, part);
    let info = await lstat(cursor).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) {
      await mkdir(cursor);
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink()) throw new TypeError("Evidence artifact path must not contain symlinks.");
    if (!info.isDirectory()) {
      const error = new TypeError("Evidence artifact path contains a non-directory parent.");
      error.code = "ENOTDIR";
      throw error;
    }
  }
  if (!isWithin(rootPath, await realpath(directory))) throw new TypeError("Evidence artifact path escapes the project root.");
}

async function readRecord(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("Evidence artifact must be a regular file.");
  return parseYaml(await readFile(path, "utf8"));
}

async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw evidenceWriteError(error, path, "write_staging_record");
  }
}

async function stagePath(root, id) {
  const directory = stageDirectory(root);
  try {
    await ensureSafeDirectory(root, directory);
  } catch (error) {
    if (!error.code) throw error;
    throw evidenceWriteError(error, directory, "prepare_staging_directory");
  }
  return artifactPath(directory, id);
}

function evidenceWriteError(error, path, operation) {
  const wrapped = new Error("Evidence staging write failed; retry this local write. Execution and verification verdicts are unchanged.", { cause: error });
  wrapped.code = "evidence_write_failed";
  wrapped.diagnostic = {
    code: "evidence_write_failed",
    retryable: true,
    operation,
    path,
    cause_code: error.code ?? "unknown",
    verdict_effect: "none",
  };
  return wrapped;
}

function event(record, status, actor, at, reason) {
  const next = { ...record, status, history: [...record.history, { status, actor, at }] };
  if (reason !== undefined) next.rejection_reason = reason;
  else delete next.rejection_reason;
  return next;
}

function validateStagedRecord(record, evidenceId) {
  const allowedFields = new Set(["schema_version", "id", "evidence", "summary", "status", "approval", "history", "rejection_reason"]);
  const allowedStatuses = new Set(["pending_approval", "rejected", "approved"]);
  const errors = [];
  if (!isRecord(record)) throw new TypeError("Staged Evidence record must be an object.");
  for (const key of Object.keys(record)) if (!allowedFields.has(key)) errors.push(`unknown field ${key}`);
  if (record.schema_version !== 1 || record.id !== evidenceId || record.evidence?.id !== evidenceId) errors.push("schema version or identity mismatch");
  if (!allowedStatuses.has(record.status)) errors.push("invalid lifecycle status");
  if (!Array.isArray(record.history) || record.history.length === 0) errors.push("history must contain lifecycle events");
  else {
    const allowedEventFields = new Set(["status", "actor", "at"]);
    let prior;
    for (const [index, item] of record.history.entries()) {
      const label = `history[${index}]`;
      if (!isRecord(item)) { errors.push(`${label} must be an object`); continue; }
      for (const key of Object.keys(item)) if (!allowedEventFields.has(key)) errors.push(`${label} has unknown field ${key}`);
      const actorText = inspectEvidenceText(item.actor);
      if (!allowedStatuses.has(item.status) || typeof item.actor !== "string" || !item.actor.trim() || actorText.invalid || actorText.forbidden || !isValidTimestamp(item.at)) errors.push(`${label} is malformed or contains unsafe metadata`);
      if (index === 0 && (item.status !== "pending_approval" || item.actor !== "import")) errors.push("history must start with imported pending_approval");
      if (prior) {
        const allowed = prior === "pending_approval"
          ? new Set(["pending_approval", "approved", "rejected"])
          : new Set(["pending_approval"]);
        if (!allowed.has(item.status)) errors.push(`${label} has invalid transition ${prior} -> ${item.status}`);
      }
      prior = item.status;
    }
    if (record.history.at(-1)?.status !== record.status) errors.push("history terminal status does not match record status");
  }
  if ((record.status === "approved") !== Boolean(record.approval)) errors.push("approval does not match lifecycle status");
  if (record.status === "approved") {
    const approvalEvent = record.history?.at(-1);
    if (!approvalEvent || approvalEvent.status !== "approved" || approvalEvent.actor !== record.approval?.actor || approvalEvent.at !== record.approval?.approved_at) {
      errors.push("approval history does not match approval actor and timestamp");
    }
  }
  if (record.status === "rejected") {
    const reasonText = inspectEvidenceText(record.rejection_reason);
    if (typeof record.rejection_reason !== "string" || !record.rejection_reason.trim() || reasonText.invalid || reasonText.forbidden) errors.push("rejected record requires a safe normalized reason");
  } else if (record.rejection_reason !== undefined) errors.push("only rejected records may have a rejection reason");
  if (errors.length) throw new TypeError(`Staged Evidence history or state is malformed: ${errors.join("; ")}`);
}

export async function importEvidence({ root = process.cwd(), input, at = new Date().toISOString() }) {
  if (!isValidTimestamp(at)) throw new TypeError("Evidence staging timestamp must be ISO 8601 with a timezone.");
  const evidence = normalizeEvidence(input);
  const path = await stagePath(root, evidence.id);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) throw new TypeError(`Evidence ${evidence.id} already exists in local staging; use stage to resume it.`);
  const record = { schema_version: 1, id: evidence.id, evidence, summary: requiredText(input.summary, "summary"), status: "pending_approval", history: [{ status: "pending_approval", actor: "import", at }] };
  const validation = validateEvidence({ ...evidence, summary: record.summary });
  if (!validation.valid) throw new TypeError(validation.errors.map(({ code, path: errorPath }) => `${code} at ${errorPath}`).join("; "));
  await atomicWrite(path, record);
  return { path, ...record };
}

export async function readStagedEvidence({ root = process.cwd(), evidenceId }) {
  const path = await stagePath(root, evidenceId);
  const record = await readRecord(path);
  validateStagedRecord(record, evidenceId);
  const validation = validateEvidence({ ...record.evidence, summary: record.summary, ...(record.approval ? { approval: record.approval } : {}) });
  if (!validation.valid) throw new TypeError(validation.errors.map(({ code, path: errorPath }) => `${code} at ${errorPath}`).join(", "));
  return record;
}

export async function stageEvidenceSummary({ root = process.cwd(), evidenceId, summary, actor = "user", at = new Date().toISOString() }) {
  if (!isValidTimestamp(at)) throw new TypeError("Evidence staging timestamp must be ISO 8601 with a timezone.");
  const current = await readStagedEvidence({ root, evidenceId });
  const next = event({ ...current, summary: requiredText(summary, "summary"), approval: undefined }, "pending_approval", requiredText(actor, "actor"), at);
  delete next.approval;
  const path = await stagePath(root, evidenceId);
  await atomicWrite(path, next);
  return { path, ...next };
}

export async function approveEvidenceSummary({ root = process.cwd(), evidenceId, actor, actorRole, at = new Date().toISOString() }) {
  if (actorRole !== "user" || typeof actor !== "string" || !actor.trim()) throw new TypeError("Evidence approval requires an explicit user actor.");
  actor = requiredText(actor, "actor");
  if (!isValidTimestamp(at)) throw new TypeError("Evidence approval timestamp must be ISO 8601 with a timezone.");
  const current = await readStagedEvidence({ root, evidenceId });
  if (current.status !== "pending_approval") throw new TypeError("Only pending Evidence summaries can be approved.");
  const body = { ...current.evidence, summary: current.summary };
  const approval = { actor_type: "human", actor: actor.trim(), approved_at: at, summary_sha256: computeEvidenceApprovalHash(body) };
  const next = { ...current, status: "approved", approval, history: [...current.history, { status: "approved", actor: actor.trim(), at }] };
  const path = await stagePath(root, evidenceId);
  await atomicWrite(path, next);
  return { path, ...next };
}

export async function rejectEvidenceSummary({ root = process.cwd(), evidenceId, actor, reason, at = new Date().toISOString() }) {
  if (typeof actor !== "string" || !actor.trim()) throw new TypeError("Evidence rejection requires a named actor.");
  actor = requiredText(actor, "actor");
  if (!isValidTimestamp(at)) throw new TypeError("Evidence rejection timestamp must be ISO 8601 with a timezone.");
  const current = await readStagedEvidence({ root, evidenceId });
  if (current.status !== "pending_approval") throw new TypeError("Only pending Evidence summaries can be rejected.");
  const next = event({ ...current, approval: undefined }, "rejected", actor.trim(), at, requiredText(reason, "rejection reason"));
  delete next.approval;
  const path = await stagePath(root, evidenceId);
  await atomicWrite(path, next);
  return { path, ...next };
}

export async function publishEvidenceSummary({ root = process.cwd(), evidenceId }) {
  const staged = await readStagedEvidence({ root, evidenceId });
  if (staged.status !== "approved" || !staged.approval) throw new TypeError("Only a user-approved Evidence summary can be published.");
  const evidence = { ...staged.evidence, summary: staged.summary, approval: staged.approval };
  const validation = validateEvidence(evidence);
  if (!validation.valid) throw new TypeError(validation.errors.map(({ code, path }) => `${code} at ${path}`).join("; "));
  try {
    return await writeEvidence({ root, evidence });
  } catch (error) {
    if (!error.code) throw error;
    const path = resolve(root, "knowledge", "evidence", `${evidenceId}.yaml`);
    throw evidenceWriteError(error, path, "publish_durable_evidence");
  }
}
