import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

import { classifyLockEntries, readHarnessLock, validateHarnessLock } from "./lock.mjs";
import { isWithin } from "../eval/util.mjs";
import { isHarnessSourceCheckout } from "./source-checkout.mjs";
import { syncOrchestratorHook } from './orchestrator-hook.mjs';
import { syncClaudeOrchestratorHook } from './claude-orchestrator-hook.mjs';
import { transformSourceContent } from './transforms.mjs';
import { LEGACY_ASSETS } from './legacy-assets.mjs';

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

async function harnessVersion(sourceRoot) {
  const data = await readFile(resolve(sourceRoot, 'package.json'), 'utf8').catch((error) => error.code === 'ENOENT' ? '{}' : Promise.reject(error));
  const version = JSON.parse(data).version;
  return typeof version === 'string' ? version : null;
}

function sourceDescriptor(sourcePath, targetPath, sourceTransform = null) {
  return { source_path: sourcePath, target_path: targetPath, source_transform: sourceTransform };
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
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".codex/internal-skills", () => true)) {
    descriptors.push(sourceDescriptor(sourcePath, sourcePath, sourcePath.endsWith(".md") ? SOURCE_TRANSFORM : null));
  }
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".codex/agents", (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".toml"))) {
    descriptors.push(sourceDescriptor(sourcePath, sourcePath, SOURCE_TRANSFORM));
    descriptors.push(sourceDescriptor(sourcePath, sourcePath.replace(/^\.codex\/agents\//, '.claude/agents/').replace(/\.toml$/, '.md'), 'claude-agent-v1'));
  }
  for (const directory of [".codex/workflows", ".codex/schemas"]) {
    for (const sourcePath of await listDirectoryFiles(sourceRoot, directory, (entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name))) descriptors.push(sourceDescriptor(sourcePath, sourcePath));
  }
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".codex/scripts", (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".mjs"))) descriptors.push(sourceDescriptor(sourcePath, sourcePath));
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".harness/src", (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".mjs"))) {
    descriptors.push(sourceDescriptor(sourcePath, sourcePath));
    if (sourcePath === ".harness/src/contracts/contracts.mjs") descriptors.push(sourceDescriptor(sourcePath, ".harness/contracts.mjs"));
  }
  for (const sourcePath of await listDirectoryFiles(sourceRoot, "bin", (entry) => entry.isFile() && /^plantuml-(bootstrap|render)\.mjs$/.test(entry.name))) {
    descriptors.push(sourceDescriptor(sourcePath, sourcePath.replace(/^bin\//, ".codex/tools/")));
  }
  descriptors.push(sourceDescriptor('bin/harness-doctor.mjs', '.codex/scripts/harness-doctor.mjs'));
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".github/workflows", (entry) => entry.isFile() && entry.name === "harness-contracts.yml")) descriptors.push(sourceDescriptor(sourcePath, sourcePath));
  for (const sourcePath of await listDirectoryFiles(sourceRoot, ".github", (entry) => entry.isFile() && entry.name === "pull_request_template.md")) {
    if (sourcePath === ".github/pull_request_template.md") descriptors.push(sourceDescriptor(sourcePath, sourcePath));
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
  for (const skill of skills.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && ['orchestrator', 'eli5', 'setup'].includes(entry.name)).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const sourcePath = `.codex/skills/${skill.name}/SKILL.md`;
    try {
      const information = await lstat(resolve(sourceRoot, sourcePath));
      if (information.isFile() || information.isSymbolicLink()) {
        for (const path of await listDirectoryFiles(sourceRoot, `.codex/skills/${skill.name}`, () => true)) {
          descriptors.push(sourceDescriptor(path, path.replace(/^\.codex\/skills\//, ".agents/skills/"), path.endsWith(".md") ? SOURCE_TRANSFORM : null));
          descriptors.push(sourceDescriptor(path, path.replace(/^\.codex\/skills\//, ".claude/skills/"), path.endsWith(".md") ? 'claude-skills-v1' : null));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new InstallerUpdateError(`Unable to inspect source skill: ${skill.name}`, { cause: error });
    }
  }
  return descriptors.sort((left, right) => left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0);
}

export async function discoverManagedAssetPaths(sourceRoot) {
  return (await discoverSourceDescriptors(sourceRoot)).map((descriptor) => descriptor.target_path);
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
  return descriptor.source_transform ? Buffer.from(transformSourceContent(content, descriptor.source_transform)) : content;
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
  return validateHarnessLock({ schema_version: 1, upstream_version: await harnessVersion(sourceRoot), files });
}

export async function writeHarnessLock({ sourceRoot, targetRoot, lockPath = DEFAULT_LOCK_PATH, excludePaths = [] } = {}) {
  const lock = await buildHarnessLock({ sourceRoot, targetRoot, excludePaths });
  await writeLockFile(targetRoot, lockPath, lock);
  return lock;
}

export async function updateProject({ sourceRoot, targetRoot, lockPath = DEFAULT_LOCK_PATH, force = false, noBackup = false, initialize = false, scope = "all" } = {}) {
  if (!sourceRoot || !targetRoot) throw new TypeError("sourceRoot and targetRoot are required");
  if (typeof force !== "boolean" || typeof noBackup !== "boolean" || typeof initialize !== "boolean" || !["all", "agents", "skills"].includes(scope)) throw new TypeError("Invalid installer force/noBackup/initialize/scope options");
  if (await isHarnessSourceCheckout(sourceRoot, targetRoot)) {
    return { lock: null, updated: [], added: [], removed_lock_entries: [], removed_directories: [], backup_directory: null, skipped: [{ path: ".codex", status: "source_checkout" }] };
  }
  const { path: lockFile } = await containedPath(targetRoot, lockPath);
  const lockInformation = await lstat(lockFile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (lockInformation?.isSymbolicLink() || (lockInformation && !lockInformation.isFile())) throw new InstallerUpdateError(`Harness lock must be a regular file: ${lockPath}`, { path: lockFile });
  const existingLock = await readHarnessLock(lockFile);
  if (!existingLock && !initialize) throw new InstallerUpdateError(`Harness lock is missing: ${lockPath}`, { path: lockFile });
  const lock = existingLock || { schema_version: 1, files: {} };
  const descriptors = await discoverSourceDescriptors(sourceRoot);
  const internalSkillNames = new Set((await readdir(resolve(sourceRoot, '.codex/internal-skills'), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const byTarget = new Map(descriptors.map((descriptor) => [descriptor.target_path, descriptor]));
  const entries = await classifyLockEntries({ root: targetRoot, lock, sourceRoot });
  const isSkill = (path) => path.startsWith(".agents/skills/") || path.startsWith(".claude/skills/") || path.startsWith(".codex/internal-skills/");
  const selected = (path) => scope === "all" || (scope === "agents" ? path.startsWith(".codex/agents/") : isSkill(path));
  const actions = [];
  const skipped = [];
  const removed_lock_entries = [];
  const nextFiles = structuredClone(lock.files);
  for (const entry of entries) {
    const descriptor = byTarget.get(entry.path);
    if (!descriptor) {
      if (!selected(entry.path)) continue;
      const target = await readTarget(targetRoot, entry.path);
      if (target && entry.current_sha256 !== entry.installed_sha256) {
        const internalizedPublicSkill = /^\.(?:agents|claude)\/skills\/([^/]+)\//.exec(entry.path)?.[1];
        if (internalizedPublicSkill && internalSkillNames.has(internalizedPublicSkill)) {
          actions.push({ descriptor: sourceDescriptor(entry.source_path || entry.path, entry.path), retired: true, backup: target.content });
          delete nextFiles[entry.path];
          removed_lock_entries.push(entry.path);
          continue;
        }
        nextFiles[entry.path] = { ...nextFiles[entry.path], retired: true };
        skipped.push({ path: entry.path, status: 'retired_locally_modified' });
        continue;
      }
      if (target) actions.push({ descriptor: sourceDescriptor(entry.source_path || entry.path, entry.path), retired: true, backup: target.content });
      delete nextFiles[entry.path];
      removed_lock_entries.push(entry.path);
      continue;
    }
    if (!selected(entry.path)) continue;
    const source = await readSource(sourceRoot, descriptor);
    if (!source) throw new InstallerUpdateError(`Harness source is missing: ${descriptor.source_path}`, { path: descriptor.source_path });
    const sourceHash = hashContent(source);
    nextFiles[entry.path] = {
      installed_sha256: entry.installed_sha256,
      upstream_sha256: sourceHash,
      source_path: descriptor.source_path,
      ...(descriptor.source_transform ? { source_transform: descriptor.source_transform } : {}),
    };
    if (entry.current_sha256 === sourceHash) nextFiles[entry.path].installed_sha256 = sourceHash;
    else if (entry.current_sha256 === null || entry.current_sha256 === entry.installed_sha256 || force || isSkill(entry.path)) {
      const target = (force || isSkill(entry.path)) && entry.current_sha256 !== null ? await readTarget(targetRoot, entry.path) : null;
      actions.push({ descriptor, content: source, sourceHash, backup: target?.content });
    } else skipped.push({ path: entry.path, status: sourceHash === entry.installed_sha256 ? "locally_modified" : "conflict" });
  }
  if (scope === "all") for (const path of new Set(LEGACY_ASSETS.filter((item) => item.action === 'retire').map((item) => item.path))) {
    if (lock.files[path]) continue;
    const target = await readTarget(targetRoot, path);
    if (target && LEGACY_ASSETS.some((item) => item.action === 'retire' && item.path === path && hashContent(target.content) === item.sha256)) actions.push({ descriptor: sourceDescriptor(path, path), retired: true, backup: target.content });
    else if (target) skipped.push({ path, status: 'legacy_unrecognized' });
  }
  for (const descriptor of descriptors) {
    if (!selected(descriptor.target_path) || nextFiles[descriptor.target_path]) continue;
    const target = await readTarget(targetRoot, descriptor.target_path);
    const source = await readSource(sourceRoot, descriptor);
    if (!source) continue;
    const sourceHash = hashContent(source);
    const knownLegacy = target && LEGACY_ASSETS.some((item) => item.action === 'replace' && item.path === descriptor.target_path && item.sha256 === hashContent(target.content));
    if (target && hashContent(target.content) !== sourceHash && !force && !isSkill(descriptor.target_path) && !knownLegacy) {
      skipped.push({ path: descriptor.target_path, status: "unlocked" });
      continue;
    }
    if (!target || hashContent(target.content) !== sourceHash) actions.push({ descriptor, content: source, sourceHash, added: !target, backup: target?.content });
    nextFiles[descriptor.target_path] = {
      installed_sha256: sourceHash,
      upstream_sha256: sourceHash,
      source_path: descriptor.source_path,
      ...(descriptor.source_transform ? { source_transform: descriptor.source_transform } : {}),
    };
  }
  let backup_directory = null;
  const backupPrefix = `.codex/installer-backups/${randomUUID()}`;
  for (const action of noBackup ? [] : actions) {
    if (!action.backup) continue;
    const backup = await containedPath(targetRoot, `${backupPrefix}/${action.descriptor.target_path}`);
    backup_directory ||= resolve(targetRoot, backupPrefix);
    await mkdir(dirname(backup.path), { recursive: true, mode: 0o700 });
    await writeFile(backup.path, action.backup, { flag: "wx", mode: 0o600 });
  }
  const removed_directories = [];
  for (const action of actions) {
    if (action.retired) {
      const target = await containedPath(targetRoot, action.descriptor.target_path);
      await unlink(target.path);
      if (action.descriptor.target_path.startsWith('.codex/harness-runtime/src/')) await removeEmptyLegacyRuntimeDirectories(targetRoot, dirname(target.path));
      else removed_directories.push(...await removeEmptyManagedDirectories(targetRoot, action.descriptor.target_path));
      continue;
    }
    await installFile(targetRoot, action.descriptor.target_path, action.content);
    nextFiles[action.descriptor.target_path] = {
      installed_sha256: action.sourceHash,
      upstream_sha256: action.sourceHash,
      source_path: action.descriptor.source_path,
      ...(action.descriptor.source_transform ? { source_transform: action.descriptor.source_transform } : {}),
    };
  }
  if (scope !== 'agents') removed_directories.push(...await pruneEmptySkillDirectories(targetRoot, new Set([...internalSkillNames, ...descriptors.map((descriptor) => /^\.(?:agents|claude)\/skills\/([^/]+)\//.exec(descriptor.target_path)?.[1]).filter(Boolean)])));
  const nextLock = validateHarnessLock({ ...lock, schema_version: 1, upstream_version: await harnessVersion(sourceRoot), files: nextFiles });
  await writeLockFile(targetRoot, lockPath, nextLock);
  if (scope !== 'agents' && await lstat(resolve(targetRoot, '.codex/scripts/harness-orchestrator-hook.mjs')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) {
    await syncOrchestratorHook(targetRoot, { noBackup });
    await syncClaudeOrchestratorHook(targetRoot, { noBackup });
  }
  return { lock: nextLock, retired: actions.filter((action) => action.retired).map((action) => action.descriptor.target_path), updated: actions.filter((action) => !action.added && !action.retired).map((action) => action.descriptor.target_path), added: actions.filter((action) => action.added).map((action) => action.descriptor.target_path), skipped, removed_lock_entries, removed_directories, backup_directory };
}

// Managed roots are the first two path segments (for example `.agents/skills`); the root itself is kept.
async function removeEmptyManagedDirectories(root, targetPath) {
  const segments = targetPath.split('/');
  if (segments.length < 4) return [];
  return removeEmptyDirectoriesUpTo(root, resolve(root, segments.slice(0, 2).join('/')), dirname(resolve(root, targetPath)));
}

async function removeEmptyDirectoriesUpTo(root, boundary, directory) {
  const rootPath = await realpath(root);
  const removed = [];
  let current = resolve(directory);
  while (current !== boundary && isWithin(boundary, current)) {
    const information = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!information || information.isSymbolicLink() || !information.isDirectory()) break;
    if (!isWithin(rootPath, await realpath(current)) || (await readdir(current)).length > 0) break;
    await rmdir(current);
    removed.push(relative(root, current));
    current = dirname(current);
  }
  return removed;
}

// Earlier updates deleted retired files but left their directories behind. Only Harness skill
// names are swept under the shared skill roots; `.codex/internal-skills` is Harness-owned.
async function pruneEmptySkillDirectories(root, harnessSkillNames) {
  const removed = [];
  for (const skillsRoot of ['.codex/internal-skills', '.agents/skills', '.claude/skills']) {
    const boundary = resolve(root, skillsRoot);
    const information = await lstat(boundary).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!information || information.isSymbolicLink() || !information.isDirectory()) continue;
    for (const entry of await readdir(boundary, { withFileTypes: true })) {
      if (!entry.isDirectory() || (skillsRoot !== '.codex/internal-skills' && !harnessSkillNames.has(entry.name))) continue;
      removed.push(...await removeEmptyTree(root, resolve(boundary, entry.name)));
    }
  }
  return removed;
}

async function removeEmptyTree(root, directory) {
  const removed = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removed.push(...await removeEmptyTree(root, resolve(directory, entry.name)));
  }
  if ((await readdir(directory)).length === 0) {
    await rmdir(directory);
    removed.push(relative(root, directory));
  }
  return removed;
}

async function removeEmptyLegacyRuntimeDirectories(root, directory) {
  const rootPath = await realpath(root);
  const boundary = resolve(root, '.codex/harness-runtime/src');
  let current = resolve(directory);
  while (isWithin(boundary, current)) {
    const information = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!information || information.isSymbolicLink() || !information.isDirectory()) return;
    const actualPath = await realpath(current);
    if (!isWithin(rootPath, actualPath) || (await readdir(current)).length > 0) return;
    await rmdir(current);
    if (current === boundary) return;
    current = dirname(current);
  }
}
