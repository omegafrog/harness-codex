import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import { isWithin } from "../eval/util.mjs";

const HASH = /^[a-f0-9]{64}$/;

export class HarnessLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HarnessLockError";
    this.reason = "invalid_harness_lock";
    this.details = details;
  }
}

function validateRelativePath(path, label) {
  const normalized = typeof path === "string" ? path.replaceAll("\\", "/") : "";
  if (typeof path !== "string" || !normalized || isAbsolute(normalized) || normalized.split("/").includes("..") || normalize(normalized) !== normalized) {
    throw new HarnessLockError(`${label} must be a repository-relative path: ${path}`);
  }
  return normalized;
}

function validateHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new HarnessLockError(`${label} must be a SHA-256 hash`);
  return value;
}

export function validateHarnessLock(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessLockError("harness lock must be an object");
  if (raw.schema_version !== 1) throw new HarnessLockError("harness lock schema_version must be 1");
  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) throw new HarnessLockError("harness lock files must be an object");
  const files = {};
  for (const [path, rawEntry] of Object.entries(raw.files)) {
    const relativePath = validateRelativePath(path, "harness lock file path");
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) throw new HarnessLockError(`harness lock entry must be an object: ${path}`);
    const installed = rawEntry.installed_sha256 || rawEntry.sha256;
    const upstream = rawEntry.upstream_sha256 || rawEntry.sha256;
    validateHash(installed, `${path}.installed_sha256`);
    validateHash(upstream, `${path}.upstream_sha256`);
    files[relativePath] = {
      ...rawEntry,
      installed_sha256: installed,
      upstream_sha256: upstream,
      ...(rawEntry.source_path === undefined ? {} : { source_path: validateRelativePath(rawEntry.source_path, `${path}.source_path`) }),
    };
  }
  return { ...raw, schema_version: 1, files };
}

export async function readHarnessLock(path) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new HarnessLockError(`Unable to read harness lock: ${path}`, { path, cause: error });
  }
  return validateHarnessLock(raw);
}

export async function hashFile(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function currentHash(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!isWithin(root, path)) throw new HarnessLockError(`Harness lock path escapes repository root: ${relativePath}`, { path });
  try {
    return await hashFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new HarnessLockError(`Unable to hash locked file: ${relativePath}`, { path, cause: error });
  }
}

function classify({ currentHashValue, installedHash, upstreamHash }) {
  if (currentHashValue === null) return "locally_modified";
  if (currentHashValue === installedHash && currentHashValue === upstreamHash) return "unchanged";
  if (upstreamHash === installedHash && currentHashValue !== installedHash) return "locally_modified";
  if (currentHashValue === installedHash || currentHashValue === upstreamHash) return "upstream_updated";
  return "conflict";
}

export async function classifyLockEntries({ root, lock, sourceRoot = null } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  const validated = validateHarnessLock(lock);
  const entries = [];
  for (const [path, entry] of Object.entries(validated.files)) {
    let upstreamHash = entry.upstream_sha256;
    if (sourceRoot && entry.source_path) {
      const source = await currentHash(sourceRoot, entry.source_path);
      if (source !== null) upstreamHash = source;
    }
    const current = await currentHash(root, path);
    entries.push({
      path,
      status: classify({ currentHashValue: current, installedHash: entry.installed_sha256, upstreamHash }),
      current_sha256: current,
      installed_sha256: entry.installed_sha256,
      upstream_sha256: upstreamHash,
      ...(entry.source_path ? { source_path: entry.source_path } : {}),
    });
  }
  return entries;
}
