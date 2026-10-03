import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseYaml } from "../eval/yaml.mjs";
import { isWithin } from "../eval/util.mjs";
import { validateArchitectureDecision, validateReviewRecord, validateSystemTargets } from "./validation.mjs";

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
  return readYamlArtifact(root, path, (value) => validateObject(validateArchitectureDecision(value, refs), "Architecture Decision"));
}

export async function writeArchitectureDecision(options = {}) {
  const { root = process.cwd(), ticketId, decision, refs = {} } = options;
  if ("path" in options) throw new TypeError("decision artifact path is not configurable");
  const path = decisionArtifactPath(root, ticketId, "architecture-decisions", decision?.id);
  return writeYamlArtifact(root, path, decision, (value) => validateObject(validateArchitectureDecision(value, refs), "Architecture Decision"));
}

export async function readReviewRecord({ root = process.cwd(), ticketId, reviewId, refs = {} }) {
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews", reviewId);
  return readYamlArtifact(root, path, (value) => validateObject(validateReviewRecord(value, refs), "Review Record"));
}

export async function writeReviewRecord(options = {}) {
  const { root = process.cwd(), ticketId, review, refs = {} } = options;
  if ("path" in options) throw new TypeError("review artifact path is not configurable");
  const path = decisionArtifactPath(root, ticketId, "architecture-reviews", review?.id);
  return writeYamlArtifact(root, path, review, (value) => validateObject(validateReviewRecord(value, refs), "Review Record"));
}
