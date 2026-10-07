import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isWithin } from "../eval/util.mjs";
import { parseYaml } from "../eval/yaml.mjs";
import { isValidTimestamp, validateClaim, validateEvidence, validatePrinciple, validateSource } from "./validation.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function registryPath(root, kind, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new TypeError(`${kind} ID must be a safe identifier.`);
  const directory = { Source: "sources", Claim: "claims", Principle: "principles", Evidence: "evidence" }[kind];
  if (!directory) throw new TypeError(`Unsupported knowledge object kind: ${kind}`);
  const path = resolve(root, "knowledge", directory, `${id}.yaml`);
  if (!isWithin(root, path)) throw new TypeError(`${kind} registry path escapes the project root`);
  return path;
}

async function assertContainedNoSymlinks(root, path, label) {
  const rootPath = await realpath(root);
  if (!isWithin(rootPath, path)) throw new TypeError(`${label} registry path escapes the project root`);
  let current = dirname(path);
  while (isWithin(rootPath, current) && current !== rootPath) {
    const info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new TypeError(`${label} registry path cannot pass through a symlink`);
    current = dirname(current);
  }
}

function validateObject(value, validateFn, label) {
  const result = validateFn(value);
  if (!result.valid) {
    const first = result.errors[0];
    const error = new TypeError(`${first.code}: ${first.path}: ${first.message}`);
    error.validation = result;
    throw error;
  }
  return label === "Source" ? value.id : value.id;
}

function validateIdentity(value, id, label) {
  if (value?.id !== id) {
    const error = new TypeError(`${label} file ${id}.yaml contains a different object ID.`);
    error.code = `${label.toLowerCase()}_id_mismatch`;
    throw error;
  }
}

async function readObject({ root, kind, id, validateFn, refs = {} }) {
  const path = registryPath(root, kind, id);
  await assertContainedNoSymlinks(root, path, kind);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`${kind} registry entry must be a regular file`);
  const value = parseYaml(await readFile(path, "utf8"));
  validateIdentity(value, id, kind);
  validateObject(value, (object) => validateFn(object, refs), kind);
  return value;
}

async function writeObject({ root, kind, value, validateFn, refs = {} }) {
  validateObject(value, (object) => validateFn(object, refs), kind);
  const path = registryPath(root, kind, value.id);
  await assertContainedNoSymlinks(root, path, kind);
  await mkdir(dirname(path), { recursive: true });
  await assertContainedNoSymlinks(root, path, kind);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError(`${kind} registry entry must be a regular file`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, [kind.toLowerCase()]: value };
}

export function readSource({ root = process.cwd(), sourceId }) {
  return readObject({ root, kind: "Source", id: sourceId, validateFn: validateSource });
}

export function writeSource({ root = process.cwd(), source }) {
  return writeObject({ root, kind: "Source", value: source, validateFn: validateSource });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function evidenceIdentity(value) {
  return `${value.origin_project}\0${value.source_reference}\0${value.type}`;
}

function evidenceContent(value) {
  const { id, approval, ...content } = value;
  return stableJson(content);
}

async function listEvidence({ root }) {
  const directory = resolve(root, "knowledge", "evidence");
  await assertContainedNoSymlinks(root, resolve(directory, ".registry-check"), "Evidence");
  const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const values = [];
  for (const name of names.filter((entry) => entry.endsWith(".yaml"))) {
    const id = name.slice(0, -5);
    values.push(await readObject({ root, kind: "Evidence", id, validateFn: validateEvidence }));
  }
  return values;
}

async function listPrinciples({ root }) {
  const directory = resolve(root, "knowledge", "principles");
  await assertContainedNoSymlinks(root, resolve(directory, ".registry-check"), "Principle");
  const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const values = [];
  for (const name of names.filter((entry) => entry.endsWith(".yaml")).sort()) {
    values.push(await readPrinciple({ root, principleId: name.slice(0, -5) }));
  }
  return values;
}

function principleMatchesQuery(principle, query) {
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}._-]+/gu) ?? [];
  if (terms.length === 0) return true;
  const haystack = [
    principle.title, principle.statement, principle.consensus,
    ...(principle.applies_when ?? []), ...(principle.exceptions ?? []),
  ].join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Read-only, project-local Principle lookup. Semantic sufficiency remains a human decision. */
export async function lookupPrinciples({ root = process.cwd(), query = "" } = {}) {
  if (typeof query !== "string") throw new TypeError("Principle lookup query must be a string.");
  const matches = (await listPrinciples({ root })).filter((principle) => principleMatchesQuery(principle, query));
  const authoritative = matches.filter((principle) => principle.status === "approved");
  const informational = matches.filter((principle) => principle.status === "candidate" || principle.status === "reviewed");
  return {
    authoritative,
    informational,
    next_step: authoritative.length ? "material_use_approval" : "research_or_approval_then_hold",
    semantic_sufficiency: authoritative.length ? "human_review_required" : "insufficient",
    registry_write_performed: false,
  };
}

export async function readEvidence({ root = process.cwd(), evidenceId }) {
  const evidence = await readObject({ root, kind: "Evidence", id: evidenceId, validateFn: validateEvidence });
  if (!evidence.approval) throw new TypeError("Durable Evidence is missing its human approval.");
  return evidence;
}

export async function writeEvidence({ root = process.cwd(), evidence }) {
  const validation = validateEvidence(evidence);
  if (!evidence?.approval) throw new TypeError("Durable Evidence requires human approval.");
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new TypeError(`${first.code}: ${first.path}: ${first.message}`);
  }
  const existingById = await lstat(registryPath(root, "Evidence", evidence?.id)).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existingById) {
    const prior = await readEvidence({ root, evidenceId: evidence.id });
    if (stableJson(prior) === stableJson(evidence)) return { path: registryPath(root, "Evidence", evidence.id), evidence: prior, idempotent: true };
    throw new TypeError(`Evidence ${evidence.id} already exists with different content.`);
  }
  const identity = evidenceIdentity(evidence);
  const sameIdentity = (await listEvidence({ root })).find((prior) => evidenceIdentity(prior) === identity);
  if (sameIdentity) {
    if (evidenceContent(sameIdentity) === evidenceContent(evidence)) {
      return { path: registryPath(root, "Evidence", sameIdentity.id), evidence: sameIdentity, idempotent: true };
    }
    throw new TypeError("Evidence conflicts with an existing same origin/run/type identity.");
  }
  const result = await writeObject({ root, kind: "Evidence", value: evidence, validateFn: validateEvidence });
  return { ...result, evidence, idempotent: false };
}

export async function readClaim({ root = process.cwd(), claimId, refs = {} }) {
  const claim = await readObject({ root, kind: "Claim", id: claimId, validateFn: validateClaim, refs });
  if (refs.sourceIds === undefined) {
    const source = await readSource({ root, sourceId: claim.source_id });
    validateObject(claim, (value) => validateClaim(value, { sourceIds: [source.id] }), "Claim");
  }
  return claim;
}

export async function writeClaim({ root = process.cwd(), claim, refs = {} }) {
  if (refs.sourceIds === undefined) {
    const source = await readSource({ root, sourceId: claim?.source_id });
    refs = { ...refs, sourceIds: [source.id] };
  }
  return writeObject({ root, kind: "Claim", value: claim, validateFn: validateClaim, refs });
}

async function principleRefs(root, principle, refs = {}) {
  if (refs.claims !== undefined && refs.sources !== undefined) return refs;
  const claimIds = [...new Set([...(principle?.supporting_claim_ids ?? []), ...(principle?.contradicting_claim_ids ?? [])])];
  const claims = refs.claims ?? await Promise.all(claimIds.map((claimId) => readClaim({ root, claimId })));
  const sourceIds = [...new Set(claims.map(({ source_id }) => source_id))];
  const sources = refs.sources ?? await Promise.all(sourceIds.map((sourceId) => readSource({ root, sourceId })));
  return { ...refs, claims, sources };
}

export async function readPrinciple({ root = process.cwd(), principleId, refs = {} }) {
  const path = registryPath(root, "Principle", principleId);
  await assertContainedNoSymlinks(root, path, "Principle");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("Principle registry entry must be a regular file");
  const value = parseYaml(await readFile(path, "utf8"));
  validateIdentity(value, principleId, "Principle");
  const resolvedRefs = await principleRefs(root, value, refs);
  validateObject(value, validatePrinciple, "Principle");
  validateObject(value, (object) => validatePrinciple(object, resolvedRefs), "Principle");
  return value;
}

export async function writePrinciple({ root = process.cwd(), principle, refs = {} }) {
  if (principle?.status === "approved") throw new TypeError("Use approvePrinciple with an explicit human actor to approve a Principle.");
  if (principle?.status === "reviewed") throw new TypeError("Use transitionPrinciple after evidence qualification to mark a Principle reviewed.");
  if (principle?.status === "deprecated") throw new TypeError("Use transitionPrinciple to deprecate an approved Principle and preserve its history.");
  if (principle?.status !== "candidate") throw new TypeError("A new Principle must begin in candidate status.");
  if (!Array.isArray(principle?.history) || principle.history.length !== 1 || principle.history[0]?.status !== "candidate") {
    throw new TypeError("A new Principle must start with only the candidate creation event from synthesizePrinciple.");
  }
  const path = registryPath(root, "Principle", principle?.id);
  await assertContainedNoSymlinks(root, path, "Principle");
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError("Principle registry entry must be a regular file");
  if (existing) throw new TypeError(`Principle ${principle.id} already exists; use revisePrinciple or transitionPrinciple to preserve lifecycle history.`);
  const resolvedRefs = await principleRefs(root, principle, refs);
  return writeObject({ root, kind: "Principle", value: principle, validateFn: validatePrinciple, refs: resolvedRefs });
}

export async function transitionPrinciple({ root = process.cwd(), principleId, to, actor, at = new Date().toISOString(), reason, refs = {}, minimum_independent_authorities = 2 }) {
  if (!isValidTimestamp(at)) throw new TypeError("Principle transition timestamp must be ISO 8601 date-time with a timezone.");
  const current = await readPrinciple({ root, principleId, refs });
  const allowed = (current.status === "candidate" && to === "reviewed") || (current.status === "approved" && to === "deprecated");
  if (!allowed) throw new TypeError(`Invalid Principle transition: ${current.status} -> ${to}`);
  const next = { ...current, status: to, history: [...(current.history ?? []), { status: to, at, actor }] };
  if (to === "deprecated") next.deprecated_reason = reason;
  if (to === "reviewed") {
    const { assessPrincipleEvidence } = await import("./research.mjs");
    const evidenceRefs = await principleRefs(root, next, refs);
    const assessment = assessPrincipleEvidence({ principle: next, claims: evidenceRefs.claims, sources: evidenceRefs.sources, minimum_independent_authorities });
    if (!assessment.approval_ready) throw new TypeError(`Principle is not ready for review: ${assessment.blockers.join(", ")}`);
  }
  const evidenceRefs = await principleRefs(root, next, refs);
  const result = to === "reviewed" || to === "deprecated"
    ? await writeObject({ root, kind: "Principle", value: next, validateFn: validatePrinciple, refs: evidenceRefs })
    : await writePrinciple({ root, principle: next, refs: evidenceRefs });
  return { ...result, principle: next };
}

export async function recordPrincipleReview({ root = process.cwd(), principleId, review, at = new Date().toISOString(), refs = {}, minimum_independent_authorities = 2 }) {
  const current = await readPrinciple({ root, principleId, refs });
  if (current.status !== "candidate") throw new TypeError("Only a candidate Principle can be reviewed.");
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new TypeError("Principle review assessment must be an object.");
  const next = { ...current, review };
  const evidenceRefs = await principleRefs(root, next, refs);
  const result = await writeObject({ root, kind: "Principle", value: next, validateFn: validatePrinciple, refs: evidenceRefs });
  if (review.outcome !== "accepted") return { ...result, principle: next };
  const transitioned = await transitionPrinciple({ root, principleId, to: "reviewed", actor: review.actor, at, refs: evidenceRefs, minimum_independent_authorities });
  return transitioned;
}

export async function approvePrinciple({ root = process.cwd(), principleId, actor, at = new Date().toISOString(), refs = {} }) {
  if (!actor || actor.role !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new TypeError("Principle approval requires an explicit user actor.");
  if (!isValidTimestamp(at)) throw new TypeError("Principle approval timestamp must be ISO 8601 date-time with a timezone.");
  const current = await readPrinciple({ root, principleId, refs });
  if (current.status !== "reviewed") throw new TypeError("Only a reviewed Principle can receive human approval.");
  const next = { ...current, status: "approved", approval: { actor_type: "human", actor: actor.id, approved_at: at, body_sha256: "" }, history: [...(current.history ?? []), { status: "approved", at, actor: actor.id }] };
  const { computePrincipleApprovalHash } = await import("./validation.mjs");
  next.approval.body_sha256 = computePrincipleApprovalHash(next);
  const resolvedRefs = await principleRefs(root, next, refs);
  const result = await writeObject({ root, kind: "Principle", value: next, validateFn: validatePrinciple, refs: resolvedRefs });
  return { ...result, principle: next };
}

export async function revisePrinciple({ root = process.cwd(), principleId, changes, actor, at = new Date().toISOString(), refs = {} }) {
  if (typeof actor !== "string" || !actor.trim()) throw new TypeError("Principle revision requires a named actor.");
  if (!isValidTimestamp(at)) throw new TypeError("Principle revision timestamp must be ISO 8601 date-time with a timezone.");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError("Principle revision changes must be an object.");
  if (["id", "schema_version", "status", "approval", "history"].some((key) => key in changes)) throw new TypeError("Principle identity, lifecycle, approval, and history are managed by the registry.");
  const current = await readPrinciple({ root, principleId, refs });
  const next = { ...current, ...changes, status: "candidate", history: [...(current.history ?? []), { status: "candidate", at, actor }] };
  delete next.approval;
  const evidenceRefs = await principleRefs(root, next, refs);
  const result = await writeObject({ root, kind: "Principle", value: next, validateFn: validatePrinciple, refs: evidenceRefs });
  return { ...result, principle: next };
}
