import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import { isWithin } from "../eval/util.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SOURCE_TRANSFORMS = new Set(["project-local-paths-v1"]);

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

async function findDanglingSymlink(root, path) {
  let candidate = resolve(path);
  const rootPath = resolve(root);
  while (isWithin(rootPath, candidate) && candidate !== rootPath) {
    try {
      const information = await lstat(candidate);
      return information.isSymbolicLink() ? candidate : null;
    } catch (error) {
      if (error.code !== "ENOENT") return null;
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
  return null;
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
      ...(rawEntry.source_transform === undefined ? {} : { source_transform: rawEntry.source_transform }),
    };
    if (rawEntry.source_transform !== undefined && !SOURCE_TRANSFORMS.has(rawEntry.source_transform)) throw new HarnessLockError(`${path}.source_transform is unsupported: ${rawEntry.source_transform}`);
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

function transformSourceContent(content, transform) {
  if (transform === "project-local-paths-v1") return content.toString("utf8").replaceAll(".codex/skills/", ".agents/skills/");
  return content;
}

async function transformedHash(root, relativePath, transform) {
  const path = resolve(root, relativePath);
  if (!isWithin(root, path)) throw new HarnessLockError(`Harness source path escapes repository root: ${relativePath}`, { path });
  try {
    const rootPath = await realpath(root);
    const actualPath = await realpath(path);
    if (!isWithin(rootPath, actualPath)) throw new HarnessLockError(`Harness source path resolves outside repository root: ${relativePath}`, { path: actualPath });
    const information = await stat(actualPath);
    if (!information.isFile()) throw new HarnessLockError(`Harness source path is not a regular file: ${relativePath}`, { path: actualPath });
    return createHash("sha256").update(transformSourceContent(await readFile(actualPath), transform)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof HarnessLockError) throw error;
    throw new HarnessLockError(`Unable to hash harness source file: ${relativePath}`, { path, cause: error });
  }
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
  if (currentHashValue === null) return "missing";
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
  const assertOwnedFile = async (relativePath) => {
    const path = resolve(root, relativePath);
    let information;
    try {
      information = await lstat(path);
      if (information.isSymbolicLink()) throw new HarnessLockError(`Harness-owned file cannot be a symlink: ${relativePath}`, { path });
      const actualPath = await realpath(path);
      if (!isWithin(rootPath, actualPath)) throw new HarnessLockError(`Harness-owned file resolves outside repository root: ${relativePath}`, { path: actualPath });
    } catch (error) {
      if (error.code === "ENOENT") {
        const dangling = await findDanglingSymlink(root, path);
        if (dangling) throw new HarnessLockError(`Harness-owned path contains a dangling symlink: ${relativePath}`, { path: dangling });
        return false;
      }
      if (error instanceof HarnessLockError) throw error;
      throw new HarnessLockError(`Unable to inspect harness-owned file: ${relativePath}`, { path, cause: error });
    }
    if (!information.isFile()) throw new HarnessLockError(`Harness-owned file must be a regular file: ${relativePath}`, { path });
    return true;
  };
  for (const [directory, predicate] of patterns) {
    const directoryPath = resolve(root, directory);
    let entries;
    try {
      const information = await lstat(directoryPath);
      if (information.isSymbolicLink() || !information.isDirectory()) throw new HarnessLockError(`Harness-owned directory must be a real directory: ${directory}`, { path: directoryPath });
      const canonicalDirectory = await realpath(directoryPath);
      if (!isWithin(rootPath, canonicalDirectory)) throw new HarnessLockError(`Harness-owned directory escapes repository root: ${directory}`, { path: canonicalDirectory });
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        const dangling = await findDanglingSymlink(root, directoryPath);
        if (dangling) throw new HarnessLockError(`Harness-owned directory contains a dangling symlink: ${directory}`, { path: dangling });
        continue;
      }
      if (error instanceof HarnessLockError) throw error;
      throw new HarnessLockError(`Unable to inspect harness-owned directory: ${directory}`, { cause: error });
    }
    for (const entry of entries.filter(predicate)) {
      const relativePath = `${directory}/${entry.name}`;
      if (await assertOwnedFile(relativePath)) files.add(relativePath);
    }
  }
  if (await assertOwnedFile(".codex/harness.yaml")) files.add(".codex/harness.yaml");
  const skillsRoot = resolve(root, ".agents/skills");
  let skillDirectories;
  try {
    const information = await lstat(skillsRoot);
    if (information.isSymbolicLink() || !information.isDirectory()) throw new HarnessLockError("Harness-owned skills root must be a real directory", { path: skillsRoot });
    const canonicalSkillsRoot = await realpath(skillsRoot);
    if (!isWithin(rootPath, canonicalSkillsRoot)) throw new HarnessLockError("Harness-owned skills escape repository root", { path: canonicalSkillsRoot });
    skillDirectories = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof HarnessLockError) throw error;
    if (error.code !== "ENOENT") throw new HarnessLockError("Unable to inspect harness-owned skills", { cause: error });
    const dangling = await findDanglingSymlink(root, skillsRoot);
    if (dangling) throw new HarnessLockError("Harness-owned skills contain a dangling symlink", { path: dangling });
    skillDirectories = [];
  }
  for (const directory of skillDirectories) {
    if (directory.isSymbolicLink()) throw new HarnessLockError(`Harness-owned skill directory cannot be a symlink: ${directory.name}`, { path: resolve(skillsRoot, directory.name) });
    if (!directory.isDirectory()) continue;
    const skillFile = resolve(skillsRoot, directory.name, "SKILL.md");
    try {
      const relativePath = `.agents/skills/${directory.name}/SKILL.md`;
      if (await assertOwnedFile(relativePath)) files.add(relativePath);
    } catch (error) {
      if (error instanceof HarnessLockError) throw error;
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
      const source = entry.source_transform
        ? await transformedHash(sourceRoot, entry.source_path, entry.source_transform)
        : await currentHash(sourceRoot, entry.source_path);
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
