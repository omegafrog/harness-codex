import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
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
  const canonicalPaths = new Set();
  for (const [path, rawEntry] of Object.entries(raw.files)) {
    const relativePath = validateRelativePath(path, "harness lock file path");
    if (canonicalPaths.has(relativePath)) throw new HarnessLockError(`Duplicate canonical harness lock path: ${relativePath}`);
    canonicalPaths.add(relativePath);
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
    const rootPath = await realpath(root);
    const actualPath = await realpath(path);
    if (!isWithin(rootPath, actualPath)) throw new HarnessLockError(`Harness lock path resolves outside repository root: ${relativePath}`, { path: actualPath });
    const information = await stat(actualPath);
    if (!information.isFile()) throw new HarnessLockError(`Harness lock path is not a regular file: ${relativePath}`, { path: actualPath });
    return await hashFile(actualPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof HarnessLockError) throw error;
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

export async function discoverHarnessOwnedFiles(root) {
  const files = new Set();
  const rootPath = await realpath(root).catch((error) => {
    throw new HarnessLockError("Unable to resolve repository root", { root, cause: error });
  });
  const patterns = [
    [".codex/agents", (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".toml")],
    [".codex/workflows", (entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name)],
    [".codex/schemas", (entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name)],
  ];
  for (const [directory, predicate] of patterns) {
    const directoryPath = resolve(root, directory);
    let entries;
    try {
      const canonicalDirectory = await realpath(directoryPath);
      if (!isWithin(rootPath, canonicalDirectory)) throw new HarnessLockError(`Harness-owned directory escapes repository root: ${directory}`, { path: canonicalDirectory });
      const information = await lstat(directoryPath);
      if (information.isSymbolicLink() || !information.isDirectory()) throw new HarnessLockError(`Harness-owned directory must be a real directory: ${directory}`, { path: directoryPath });
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error instanceof HarnessLockError) throw error;
      throw new HarnessLockError(`Unable to inspect harness-owned directory: ${directory}`, { cause: error });
    }
    for (const entry of entries.filter(predicate)) files.add(`${directory}/${entry.name}`);
  }
  const skillsRoot = resolve(root, ".agents/skills");
  let skillDirectories;
  try {
    const canonicalSkillsRoot = await realpath(skillsRoot);
    if (!isWithin(rootPath, canonicalSkillsRoot)) throw new HarnessLockError("Harness-owned skills escape repository root", { path: canonicalSkillsRoot });
    const information = await lstat(skillsRoot);
    if (information.isSymbolicLink() || !information.isDirectory()) throw new HarnessLockError("Harness-owned skills root must be a real directory", { path: skillsRoot });
    skillDirectories = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof HarnessLockError) throw error;
    if (error.code !== "ENOENT") throw new HarnessLockError("Unable to inspect harness-owned skills", { cause: error });
    skillDirectories = [];
  }
  for (const directory of skillDirectories.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())) {
    const skillFile = resolve(skillsRoot, directory.name, "SKILL.md");
    try {
      const information = await lstat(skillFile);
      if (information.isFile() || information.isSymbolicLink()) files.add(`.agents/skills/${directory.name}/SKILL.md`);
    } catch (error) {
      if (error.code !== "ENOENT") throw new HarnessLockError(`Unable to inspect skill: ${directory.name}`, { cause: error });
    }
  }
  return [...files].sort();
}

export async function classifyLockEntries({ root, lock, sourceRoot = null } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  const validated = validateHarnessLock(lock);
  const entries = [];
  for (const [path, entry] of Object.entries(validated.files)) {
    let upstreamHash = entry.upstream_sha256;
    let sourceMissing = false;
    if (sourceRoot && entry.source_path) {
      const source = await currentHash(sourceRoot, entry.source_path);
      if (source !== null) upstreamHash = source;
      else sourceMissing = true;
    }
    const current = await currentHash(root, path);
    entries.push({
      path,
      status: classify({ currentHashValue: current, installedHash: entry.installed_sha256, upstreamHash }),
      current_sha256: current,
      installed_sha256: entry.installed_sha256,
      upstream_sha256: upstreamHash,
      source_missing: sourceMissing,
      ...(entry.source_path ? { source_path: entry.source_path } : {}),
    });
  }
  return entries;
}
