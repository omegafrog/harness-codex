import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import { classifyLockEntries, readHarnessLock, validateHarnessLock } from "./lock.mjs";
import { isWithin } from "../eval/util.mjs";

const DEFAULT_LOCK_PATH = ".codex/harness-lock.json";
const SOURCE_TRANSFORM = "project-local-paths-v1";

export class InstallerUpdateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InstallerUpdateError";
    this.details = details;
  }
}

function validateRelativePath(path, label) {
  const normalized = typeof path === "string" ? path.replaceAll("\\", "/") : "";
  if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..") || normalize(normalized) !== normalized) throw new InstallerUpdateError(`${label} must be a repository-relative path: ${path}`);
  return normalized;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sourceDescriptor(sourcePath, targetPath, sourceTransform = null) {
  return { source_path: sourcePath, target_path: targetPath, source_transform: sourceTransform };
}

function isInstallableDescriptor(descriptor) {
  return descriptor.source_path !== ".codex/harness.yaml";
}

async function listDirectoryFiles(root, directory, predicate) {
  const path = resolve(root, directory);
  try {
    const rootPath = await realpath(root);
    const canonicalDirectory = await realpath(path);
    if (!isWithin(rootPath, canonicalDirectory)) throw new InstallerUpdateError(`Harness source directory escapes repository root: ${directory}`, { path: canonicalDirectory });
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isDirectory()) throw new InstallerUpdateError(`Harness source directory must be a real directory: ${directory}`, { path });
    const files = [];
    const walk = async (currentPath, relativeDirectory) => {
      const entries = (await readdir(currentPath, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        const relativePath = `${relativeDirectory}/${entry.name}`;
        const entryPath = resolve(root, relativePath);
        if (entry.isSymbolicLink()) throw new InstallerUpdateError(`Harness source path cannot be a symlink: ${relativePath}`, { path: entryPath });
        if (entry.isDirectory()) await walk(entryPath, relativePath);
        else if (entry.isFile() && predicate(entry)) files.push(relativePath);
      }
    };
    await walk(path, directory);
    return files;
  } catch (error) {
    if (error.code === "ENOENT") {
      const dangling = await findDanglingSymlink(root, path);
      if (dangling) throw new InstallerUpdateError(`Harness source directory contains a dangling symlink: ${directory}`, { path: dangling });
      return [];
    }
    if (error instanceof InstallerUpdateError) throw error;
    throw new InstallerUpdateError(`Unable to inspect harness source directory: ${directory}`, { cause: error });
  }
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

async function discoverSourceDescriptors(sourceRoot) {
  const descriptors = [];
  try {
    const information = await lstat(resolve(sourceRoot, ".codex/harness.yaml"));
    if (information.isFile() || information.isSymbolicLink()) descriptors.push(sourceDescriptor(".codex/harness.yaml", ".codex/harness.yaml"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new InstallerUpdateError("Unable to inspect harness source configuration", { cause: error });
  }
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".codex/agents", (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".toml"))) {
    descriptors.push(sourceDescriptor(sourcePath, sourcePath, SOURCE_TRANSFORM));
  }
  for (const directory of [".codex/workflows", ".codex/schemas"]) {
    for (const sourcePath of await listDirectoryFiles(sourceRoot, directory, (entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name))) descriptors.push(sourceDescriptor(sourcePath, sourcePath));
  }
  const skillsRoot = resolve(sourceRoot, ".codex/skills");
  let skills;
  try {
    const rootPath = await realpath(sourceRoot);
    const canonicalSkillsRoot = await realpath(skillsRoot);
    if (!isWithin(rootPath, canonicalSkillsRoot)) throw new InstallerUpdateError("Harness source skills escape repository root", { path: canonicalSkillsRoot });
    const information = await lstat(skillsRoot);
    if (information.isSymbolicLink() || !information.isDirectory()) throw new InstallerUpdateError("Harness source skills root must be a real directory", { path: skillsRoot });
    skills = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      const dangling = await findDanglingSymlink(sourceRoot, skillsRoot);
      if (dangling) throw new InstallerUpdateError("Harness source skills contain a dangling symlink", { path: dangling });
      skills = [];
    }
    else if (error instanceof InstallerUpdateError) throw error;
    else throw new InstallerUpdateError("Unable to inspect harness source skills", { cause: error });
  }
  for (const skill of skills.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const sourcePath = `.codex/skills/${skill.name}/SKILL.md`;
    const targetPath = `.agents/skills/${skill.name}/SKILL.md`;
    try {
      const information = await lstat(resolve(sourceRoot, sourcePath));
      if (information.isFile() || information.isSymbolicLink()) descriptors.push(sourceDescriptor(sourcePath, targetPath));
    } catch (error) {
      if (error.code !== "ENOENT") throw new InstallerUpdateError(`Unable to inspect source skill: ${skill.name}`, { cause: error });
    }
  }
  return descriptors.sort((left, right) => left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0);
}

async function readSource(root, descriptor) {
  const path = resolve(root, descriptor.source_path);
  const rootPath = await realpath(root);
  const actualPath = await realpath(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw new InstallerUpdateError(`Unable to resolve harness source: ${descriptor.source_path}`, { cause: error });
  });
  if (!actualPath) return null;
  if (!isWithin(rootPath, actualPath)) throw new InstallerUpdateError(`Harness source resolves outside repository root: ${descriptor.source_path}`, { path: actualPath });
  const lexicalInfo = await lstat(path);
  if (lexicalInfo.isSymbolicLink()) throw new InstallerUpdateError(`Harness source cannot be a symlink: ${descriptor.source_path}`, { path });
  const information = await stat(actualPath);
  if (!information.isFile()) throw new InstallerUpdateError(`Harness source is not a regular file: ${descriptor.source_path}`, { path: actualPath });
  const content = await readFile(actualPath);
  return descriptor.source_transform === SOURCE_TRANSFORM ? Buffer.from(content.toString("utf8").replaceAll(".codex/skills/", ".agents/skills/"), "utf8") : content;
}

async function containedPath(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!isWithin(root, path)) throw new InstallerUpdateError(`Harness target escapes repository root: ${relativePath}`, { path });
  const rootPath = await realpath(root);
  let parent = dirname(path);
  let parentPath = null;
  while (true) {
    try {
      parentPath = await realpath(parent);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw new InstallerUpdateError(`Unable to resolve harness target parent: ${relativePath}`, { path: parent, cause: error });
      const dangling = await findDanglingSymlink(root, parent);
      if (dangling) throw new InstallerUpdateError(`Harness target parent contains a dangling symlink: ${relativePath}`, { path: dangling });
      const next = dirname(parent);
      if (next === parent) throw new InstallerUpdateError(`Harness target parent does not exist: ${relativePath}`, { path: parent });
      parent = next;
    }
  }
  if (!isWithin(rootPath, parentPath)) throw new InstallerUpdateError(`Harness target parent resolves outside repository root: ${relativePath}`, { path: parentPath });
  return { path, rootPath };
}

async function readTarget(root, relativePath) {
  const { path, rootPath } = await containedPath(root, relativePath);
  const information = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!information) return null;
  if (information.isSymbolicLink() || !information.isFile()) throw new InstallerUpdateError(`Harness target must be a regular file: ${relativePath}`, { path });
  const actualPath = await realpath(path);
  if (!isWithin(rootPath, actualPath)) throw new InstallerUpdateError(`Harness target resolves outside repository root: ${relativePath}`, { path: actualPath });
  return { path, content: await readFile(path) };
}

async function installFile(root, relativePath, content) {
  const { path } = await containedPath(root, relativePath);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new InstallerUpdateError(`Harness target must be a regular file: ${relativePath}`, { path });
  await mkdir(dirname(path), { recursive: true });
  await containedPath(root, relativePath);
  const temporary = `${path}.harness-update-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new InstallerUpdateError(`Unable to replace harness target: ${relativePath}`, { path, cause: error });
  }
}

async function writeLockFile(targetRoot, lockPath, lock) {
  const { path } = await containedPath(targetRoot, lockPath);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new InstallerUpdateError(`Harness lock must be a regular file: ${lockPath}`, { path });
  await mkdir(dirname(path), { recursive: true });
  await containedPath(targetRoot, lockPath);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new InstallerUpdateError(`Unable to write harness lock: ${lockPath}`, { path, cause: error });
  }
}

export async function buildHarnessLock({ sourceRoot, targetRoot, excludePaths = [] } = {}) {
  if (!sourceRoot || !targetRoot) throw new TypeError("sourceRoot and targetRoot are required");
  const excluded = new Set(excludePaths.map((path) => validateRelativePath(path, "excluded harness lock path")));
  const files = {};
  for (const descriptor of await discoverSourceDescriptors(sourceRoot)) {
    if (excluded.has(descriptor.target_path)) continue;
    const source = await readSource(sourceRoot, descriptor);
    if (!source) continue;
    const target = await readTarget(targetRoot, descriptor.target_path);
    if (!target) continue;
    const upstream = hashContent(source);
    files[validateRelativePath(descriptor.target_path, "harness lock target path")] = {
      installed_sha256: hashContent(target.content),
      upstream_sha256: upstream,
      source_path: descriptor.source_path,
      ...(descriptor.source_transform ? { source_transform: descriptor.source_transform } : {}),
    };
  }
  return validateHarnessLock({ schema_version: 1, files });
}

export async function writeHarnessLock({ sourceRoot, targetRoot, lockPath = DEFAULT_LOCK_PATH, excludePaths = [] } = {}) {
  const lock = await buildHarnessLock({ sourceRoot, targetRoot, excludePaths });
  await writeLockFile(targetRoot, lockPath, lock);
  return lock;
}

export async function updateProject({ sourceRoot, targetRoot, lockPath = DEFAULT_LOCK_PATH } = {}) {
  if (!sourceRoot || !targetRoot) throw new TypeError("sourceRoot and targetRoot are required");
  const { path: lockFile } = await containedPath(targetRoot, lockPath);
  const lockInformation = await lstat(lockFile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (lockInformation?.isSymbolicLink() || (lockInformation && !lockInformation.isFile())) throw new InstallerUpdateError(`Harness lock must be a regular file: ${lockPath}`, { path: lockFile });
  const lock = await readHarnessLock(lockFile);
  if (!lock) throw new InstallerUpdateError(`Harness lock is missing: ${lockPath}`, { path: lockFile });
  const descriptors = await discoverSourceDescriptors(sourceRoot);
  const byTarget = new Map(descriptors.map((descriptor) => [descriptor.target_path, descriptor]));
  const entries = await classifyLockEntries({ root: targetRoot, lock, sourceRoot });
  const actions = [];
  const skipped = [];
  const nextFiles = structuredClone(lock.files);
  for (const entry of entries) {
    const descriptor = byTarget.get(entry.path);
    if (entry.source_missing) throw new InstallerUpdateError(`Harness source is missing: ${entry.source_path}`, { path: entry.source_path });
    if (!descriptor) {
      skipped.push({ path: entry.path, status: "stale_source" });
      continue;
    }
    const source = await readSource(sourceRoot, descriptor);
    if (!source) throw new InstallerUpdateError(`Harness source is missing: ${descriptor.source_path}`, { path: descriptor.source_path });
    const sourceHash = hashContent(source);
    nextFiles[entry.path].upstream_sha256 = sourceHash;
    if (entry.current_sha256 === null || entry.status === "upstream_updated") actions.push({ descriptor, content: source, sourceHash });
    else if (entry.status === "locally_modified" || entry.status === "conflict") skipped.push({ path: entry.path, status: entry.status });
  }
  for (const descriptor of descriptors) {
    if (nextFiles[descriptor.target_path]) continue;
    if (!isInstallableDescriptor(descriptor)) {
      skipped.push({ path: descriptor.target_path, status: "requires_explicit_setup" });
      continue;
    }
    const target = await readTarget(targetRoot, descriptor.target_path);
    if (target) {
      skipped.push({ path: descriptor.target_path, status: "unlocked" });
      continue;
    }
    const source = await readSource(sourceRoot, descriptor);
    if (!source) continue;
    const sourceHash = hashContent(source);
    actions.push({ descriptor, content: source, sourceHash, added: true });
    nextFiles[descriptor.target_path] = {
      installed_sha256: sourceHash,
      upstream_sha256: sourceHash,
      source_path: descriptor.source_path,
      ...(descriptor.source_transform ? { source_transform: descriptor.source_transform } : {}),
    };
  }
  for (const action of actions) {
    await installFile(targetRoot, action.descriptor.target_path, action.content);
    nextFiles[action.descriptor.target_path] = {
      ...(nextFiles[action.descriptor.target_path] || {}),
      installed_sha256: action.sourceHash,
      upstream_sha256: action.sourceHash,
      source_path: action.descriptor.source_path,
      ...(action.descriptor.source_transform ? { source_transform: action.descriptor.source_transform } : {}),
    };
  }
  const nextLock = validateHarnessLock({ ...lock, schema_version: 1, files: nextFiles });
  await writeLockFile(targetRoot, lockPath, nextLock);
  return { lock: nextLock, updated: actions.filter((action) => !action.added).map((action) => action.descriptor.target_path), added: actions.filter((action) => action.added).map((action) => action.descriptor.target_path), skipped };
}
