import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { readArchitectureDecision } from "../decision/artifacts.mjs";
import { importEvidence, normalizeEvidence, readStagedEvidence } from "./evidence.mjs";

const PURPOSES = new Set(["code_validation", "decision_validation"]);

function diagnostic(code, message, details = {}) {
  return { collected: false, diagnostic: { code, message, ...details } };
}

async function resolveDecision(root, decisionId) {
  const specs = resolve(root, "docs", "specs");
  const ticketIds = await readdir(specs, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of ticketIds.filter((item) => item.isDirectory())) {
    try {
      const decision = await readArchitectureDecision({ root, ticketId: entry.name, decisionId });
      return decision;
    } catch { /* Missing or malformed Decision artifacts are not resolvable references. */ }
  }
  return null;
}

function safeIdentityPart(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) throw new TypeError(`${label} must be non-empty normalized text.`);
  return value.trim();
}

/** Collect an execution observation using only its declared purpose and normalized result fields. */
export async function collectRuntimeEvidence({ root = process.cwd(), definition, observation }) {
  const purpose = definition?.execution_purpose;
  if (!PURPOSES.has(purpose)) return diagnostic("unsupported_execution_purpose", "Runtime Evidence requires an explicitly supported execution_purpose.");

  let decisionIds = [];
  if (purpose === "decision_validation") {
    if (!Array.isArray(definition.decision_ids) || definition.decision_ids.length === 0) return diagnostic("missing_decision_reference", "decision_validation requires one or more declared decision_ids.");
    decisionIds = [...new Set(definition.decision_ids)];
    if (decisionIds.length !== definition.decision_ids.length) return diagnostic("duplicate_decision_reference", "decision_ids must be unique.");
    for (const id of decisionIds) {
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !(await resolveDecision(root, id))) {
        return diagnostic("unresolved_decision_reference", `Decision reference ${String(id)} does not resolve to a valid Architecture Decision.`, { decision_id: id });
      }
    }
  }

  try {
    const origin = safeIdentityPart(observation?.origin_project, "origin_project");
    const runId = safeIdentityPart(observation?.run_id, "run_id");
    const eventId = safeIdentityPart(observation?.event_id, "event_id");
    const type = safeIdentityPart(observation?.type, "type");
    const sourceReference = `${runId}/${eventId}`;
    const id = `runtime-${createHash("sha256").update(`${origin}\0${runId}\0${eventId}\0${type}`).digest("hex").slice(0, 40)}`;
    const candidate = {
      id,
      origin_project: origin,
      environment: observation.environment,
      timestamp: observation.timestamp,
      type,
      execution_status: observation.execution_status,
      measurement_validity: observation.measurement_validity,
      observations: observation.observations,
      source_reference: sourceReference,
      execution_purpose: purpose,
      decision_ids: decisionIds,
      summary: observation.summary,
    };
    try {
      const prior = await readStagedEvidence({ root, evidenceId: id });
      const comparable = (value) => JSON.stringify(value);
      if (comparable(prior.evidence) === comparable(normalizeEvidence(candidate)) && prior.summary === candidate.summary) {
        return { collected: true, idempotent: true, evidence: prior.evidence, path: prior.path };
      }
      return diagnostic("runtime_evidence_identity_conflict", "The same origin/run/event/type identity produced different normalized content.", { evidence_id: id });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = await importEvidence({ root, input: candidate });
    return { collected: true, idempotent: false, evidence: result.evidence, path: result.path };
  } catch (error) {
    return diagnostic(error.code === "evidence_write_failed" ? "evidence_write_failed" : "invalid_runtime_observation", error.message, error.diagnostic ? { collection_diagnostic: error.diagnostic } : {});
  }
}
