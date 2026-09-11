import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadHarnessConfig } from "../eval/case-loader.mjs";
import { readHarnessLock, classifyLockEntries, discoverHarnessOwnedFiles } from "../installer/lock.mjs";
import { WorkflowManifestError, loadWorkflowFile } from "../workflow/loader.mjs";
import { isWithin } from "../eval/util.mjs";
import { IMPLEMENTATION_PR_HEADINGS, IMPLEMENTATION_PR_MANAGED_END, IMPLEMENTATION_PR_MANAGED_START } from "../tracker/authoring.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_WORKFLOW_DIR = ".codex/workflows";
const DEFAULT_LOCK_PATH = ".codex/harness-lock.json";

function safeMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  try {
    const message = String(error);
    return message || fallback;
  } catch {
    return fallback;
  }
}

function diagnostic(code, severity, message, path, details = {}) {
  return { code, severity, message, path, ...details };
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

function classifyWorkflowError(error) {
  const message = safeMessage(error, "workflow validation failed");
  if (/Missing (?:role profile|skill)/i.test(message)) return "broken_reference";
  if (/undeclared (?:role|skill)/i.test(message)) return "agent_skill_workflow_mismatch";
  return "workflow_schema";
}

async function readContainedRegularFile(root, path, label) {
  let resolvedRoot;
  let resolvedPath;
  try {
    resolvedRoot = await realpath(root);
    resolvedPath = await realpath(path);
  } catch (error) {
    throw new Error(`Unable to resolve ${label}: ${safeMessage(error, "unknown filesystem error")}`, { cause: error });
  }
  if (!isWithin(resolvedRoot, resolvedPath)) throw new Error(`${label} escapes repository root: ${path}`);
  const information = await stat(resolvedPath);
  if (!information.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return readFile(resolvedPath, "utf8");
}

async function inspectWorkflows(root, diagnostics) {
  const directory = resolve(root, DEFAULT_WORKFLOW_DIR);
  let entries;
  try {
    const information = await lstat(directory);
    if (information.isSymbolicLink() || !information.isDirectory()) {
      diagnostics.push(diagnostic("workflow_schema", "error", "Canonical workflow directory must be a real directory", directory));
      return;
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      diagnostics.push(diagnostic("workflow_schema", "error", "Canonical workflow directory is missing", directory));
      return;
    }
    diagnostics.push(diagnostic("workflow_schema", "error", safeMessage(error, "Unable to read workflow directory"), directory));
    return;
  }
  const workflowFiles = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name).sort();
  if (workflowFiles.length === 0) diagnostics.push(diagnostic("workflow_schema", "warning", "No workflow definitions found", directory));
  for (const name of workflowFiles) {
    const path = join(directory, name);
    try {
      const workflow = await loadWorkflowFile(path, { root });
      const legacySkillRoot = resolve(root, ".codex/skills");
      for (const [skill, skillPath] of Object.entries(workflow.references.skills)) {
        if (isWithin(legacySkillRoot, skillPath)) diagnostics.push(diagnostic("stale_skill_path", "warning", `Workflow ${workflow.id} resolves skill ${skill} from legacy .codex/skills`, skillPath));
      }
    } catch (error) {
      diagnostics.push(diagnostic(classifyWorkflowError(error), "error", safeMessage(error, "Workflow validation failed"), error.details?.path || path));
    }
  }
}

async function inspectPermissions(root, diagnostics, nativePermissionProfiles = null) {
  const configPath = resolve(root, ".codex/harness.yaml");
  let config;
  try {
    config = await loadHarnessConfig(root);
  } catch (error) {
    diagnostics.push(diagnostic("permission_conflict", "error", `Unable to load harness permission configuration: ${safeMessage(error, "unknown configuration error")}`, configPath));
    return;
  }
  const profiles = config.eval?.environment_profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    diagnostics.push(diagnostic("permission_conflict", "error", "No environment permission profiles are configured", configPath));
    return;
  }
  const definitions = new Map();
  const references = new Map();
  for (const [name, profile] of Object.entries(profiles)) {
    const path = `${configPath}#eval.environment_profiles.${name}`;
    if (!profile || typeof profile.permission_profile !== "string" || !profile.permission_profile.trim() || !["read-only", "workspace-write"].includes(profile.sandbox) || !["restricted", "allowed", "disabled"].includes(profile.network)) {
      diagnostics.push(diagnostic("permission_conflict", "error", `Environment profile ${name} is incomplete or unsafe`, path));
      continue;
    }
    const signature = JSON.stringify({ sandbox: profile.sandbox, network: profile.network });
    if (!references.has(profile.permission_profile)) references.set(profile.permission_profile, []);
    references.get(profile.permission_profile).push(path);
    const previous = definitions.get(profile.permission_profile);
    if (previous && previous.signature !== signature) {
      diagnostics.push(diagnostic("permission_conflict", "error", `Native permission profile ${profile.permission_profile} has conflicting environment definitions`, path, { profiles: [previous.name, name] }));
    } else if (!previous) {
      definitions.set(profile.permission_profile, { name, signature });
    }
  }
  const agentsDirectory = resolve(root, ".codex/agents");
  try {
    const directoryInfo = await lstat(agentsDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      diagnostics.push(diagnostic("permission_conflict", "error", "Canonical agent directory must be a real directory", agentsDirectory));
      return;
    }
    const agentEntries = (await readdir(agentsDirectory, { withFileTypes: true }))
      .filter((candidate) => (candidate.isFile() || candidate.isSymbolicLink()) && candidate.name.endsWith(".toml"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of agentEntries) {
      const path = join(agentsDirectory, entry.name);
      const text = await readContainedRegularFile(root, path, `Agent profile ${entry.name}`);
      for (const match of text.matchAll(/^\s*permission_profile\s*=\s*["']([^"']+)["']\s*$/gm)) {
        const reference = match[1];
        if (!references.has(reference)) references.set(reference, []);
        references.get(reference).push(path);
      }
      if (text.includes(".codex/skills/")) diagnostics.push(diagnostic("stale_agent_path", "warning", `Agent profile ${entry.name} contains a legacy .codex/skills reference`, path));
    }
  } catch (error) {
    if (error.code !== "ENOENT") diagnostics.push(diagnostic("permission_conflict", "error", safeMessage(error, "Unable to inspect agent permission references"), agentsDirectory));
  }
  const orderedReferences = [...references.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (nativePermissionProfiles !== null) {
    if (!Array.isArray(nativePermissionProfiles) || nativePermissionProfiles.some((profile) => typeof profile !== "string" || !profile.trim())) {
      diagnostics.push(diagnostic("permission_conflict", "error", "Native permission profile inventory must be a list of non-empty names", configPath));
      return;
    }
    const available = new Set(nativePermissionProfiles);
    for (const [reference, paths] of orderedReferences) {
      if (!available.has(reference)) for (const path of [...paths].sort()) diagnostics.push(diagnostic("permission_profile_stale", "error", `Native permission profile is missing: ${reference}`, path, { permission_profile: reference }));
    }
  } else {
    for (const [reference, paths] of orderedReferences) diagnostics.push(diagnostic("permission_profile_unverified", "error", `Native permission profile was not verified: ${reference}`, [...paths].sort()[0], { permission_profile: reference }));
  }
}

async function inspectLock(root, lockPath, sourceRoot, diagnostics) {
  if (lockPath === null) {
    try {
      await discoverHarnessOwnedFiles(root);
    } catch (error) {
      diagnostics.push(diagnostic("installer_path_invalid", "error", safeMessage(error, "Invalid harness-owned path"), error.details?.path || root));
    }
    return;
  }
  const path = resolve(root, lockPath);
  if (!isWithin(root, path)) {
    diagnostics.push(diagnostic("installer_lock_invalid", "error", "Harness lock escapes repository root", path));
    return;
  }
  let lock;
  try {
    const lockPathInfo = await lstat(path);
    if (lockPathInfo.isSymbolicLink() || !lockPathInfo.isFile()) {
      diagnostics.push(diagnostic("installer_lock_invalid", "error", "Harness lock must be a regular file and cannot be a symlink", path));
      return;
    }
    const repositoryPath = await realpath(root);
    const canonicalLockPath = await realpath(path);
    if (!isWithin(repositoryPath, canonicalLockPath)) {
      diagnostics.push(diagnostic("installer_lock_invalid", "error", "Harness lock resolves outside repository root", canonicalLockPath));
      return;
    }
    lock = await readHarnessLock(canonicalLockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      const dangling = await findDanglingSymlink(root, path);
      if (dangling) diagnostics.push(diagnostic("installer_lock_invalid", "error", "Harness lock path contains a dangling symlink", dangling));
      else diagnostics.push(diagnostic("installer_lock_missing", "warning", "harness-lock.json is missing; installer drift cannot be checked", path));
    } else diagnostics.push(diagnostic("installer_lock_invalid", "error", safeMessage(error, "Invalid harness lock"), path));
    return;
  }
  if (!lock) return;
  try {
    const entries = await classifyLockEntries({ root, lock, sourceRoot });
    const ownedFiles = new Set(await discoverHarnessOwnedFiles(root));
    const lockedFiles = new Set(entries.map((entry) => entry.path));
    for (const path of ownedFiles) if (!lockedFiles.has(path)) diagnostics.push(diagnostic("installer_unlocked_file", "warning", `Harness-owned file is not present in harness-lock.json: ${path}`, resolve(root, path)));
    for (const entry of entries) {
      if (entry.status === "conflict") diagnostics.push(diagnostic("installer_conflict", "error", `Harness file changed locally and upstream: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      else if (entry.status === "locally_modified") diagnostics.push(diagnostic("installer_locally_modified", "warning", `Harness file was modified locally: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      else if (entry.status === "upstream_updated") diagnostics.push(diagnostic("installer_upstream_updated", "info", `Harness file has an upstream update: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      if (entry.current_sha256 === null) diagnostics.push(diagnostic("installer_missing_file", "error", `Locked harness file is missing: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      if (entry.source_missing) diagnostics.push(diagnostic("installer_source_missing", "error", `Locked upstream source file is missing: ${entry.source_path}`, resolve(root, entry.path), { source_path: entry.source_path }));
      if (!ownedFiles.has(entry.path)) diagnostics.push(diagnostic("installer_stale_lock_entry", "warning", `Lock entry is no longer an installed harness file: ${entry.path}`, resolve(root, entry.path)));
    }
  } catch (error) {
    diagnostics.push(diagnostic("installer_lock_invalid", "error", safeMessage(error, "Unable to classify harness lock"), path));
  }
}

async function inspectAuthoring(root, diagnostics) {
  const githubDirectory = resolve(root, ".github");
  let githubInfo;
  try {
    githubInfo = await lstat(githubDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    diagnostics.push(diagnostic("authoring_managed_section", "error", safeMessage(error, "Unable to inspect .github"), githubDirectory));
    return;
  }
  if (githubInfo.isSymbolicLink() || !githubInfo.isDirectory()) {
    diagnostics.push(diagnostic("authoring_managed_section", "error", "Canonical .github directory must be a real directory", githubDirectory));
    return;
  }
  const templatePath = join(githubDirectory, "pull_request_template.md");
  let template;
  try {
    template = await readContainedRegularFile(root, templatePath, "Pull request template");
  } catch (error) {
    if (error.code === "ENOENT") diagnostics.push(diagnostic("authoring_managed_section", "error", "Canonical pull request template is missing", templatePath));
    else diagnostics.push(diagnostic("authoring_managed_section", "error", safeMessage(error, "Unable to inspect pull request template"), templatePath));
    return;
  }
  const starts = [...template.matchAll(new RegExp(IMPLEMENTATION_PR_MANAGED_START, "g"))].map((match) => match.index);
  const ends = [...template.matchAll(new RegExp(IMPLEMENTATION_PR_MANAGED_END, "g"))].map((match) => match.index);
  const start = starts[0] ?? -1;
  const end = ends[0] ?? -1;
  const validManagedSection = starts.length === 1 && ends.length === 1 && start >= 0 && end > start;
  if (!validManagedSection) diagnostics.push(diagnostic("authoring_managed_section", "error", "Pull request template must contain exactly one ordered canonical managed section", templatePath));
  const managed = validManagedSection ? template.slice(start + IMPLEMENTATION_PR_MANAGED_START.length, end) : template;
  const headingCounts = new Map(IMPLEMENTATION_PR_HEADINGS.map((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [heading, (managed.match(new RegExp(`^## ${escaped}$`, "gm")) ?? []).length];
  }));
  const missingHeadings = IMPLEMENTATION_PR_HEADINGS.filter((heading) => headingCounts.get(heading) === 0);
  const duplicateHeadings = IMPLEMENTATION_PR_HEADINGS.filter((heading) => headingCounts.get(heading) > 1);
  if (missingHeadings.length > 0) diagnostics.push(diagnostic("authoring_managed_section", "error", `Pull request template is missing canonical sections: ${missingHeadings.join(", ")}`, templatePath, { missing_sections: missingHeadings }));
  if (duplicateHeadings.length > 0) diagnostics.push(diagnostic("authoring_managed_section", "error", `Pull request template contains duplicate canonical sections: ${duplicateHeadings.join(", ")}`, templatePath, { duplicate_sections: duplicateHeadings }));
  if (validManagedSection) {
    const outside = `${template.slice(0, start)}\n${template.slice(end + IMPLEMENTATION_PR_MANAGED_END.length)}`;
    const outsideSections = IMPLEMENTATION_PR_HEADINGS.filter((heading) => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^## ${escaped}$`, "m").test(outside);
    });
    if (outsideSections.length > 0) diagnostics.push(diagnostic("authoring_managed_section", "error", `Canonical PR sections must stay inside the managed section: ${outsideSections.join(", ")}`, templatePath, { outside_sections: outsideSections }));
  }
  const headingPositions = IMPLEMENTATION_PR_HEADINGS.map((heading) => managed.indexOf(`## ${heading}`));
  if (headingPositions.some((position, index) => position < 0 || (index > 0 && position <= headingPositions[index - 1]))) diagnostics.push(diagnostic("authoring_managed_section", "error", "Pull request template canonical sections must remain in order inside the managed section", templatePath));
  if (!managed.includes("Closes #<PARENT-ISSUE-NUMBER>") || !managed.includes("Closes #<CHILD-ISSUE-NUMBER>")) diagnostics.push(diagnostic("authoring_closing_refs", "error", "Pull request template must reserve closing references for the parent and every child Issue", templatePath));
  if (!managed.includes("Single integration PR: required")) diagnostics.push(diagnostic("authoring_single_pr_invariant", "error", "Pull request template must declare one integration PR per plan set", templatePath));
}

export async function runDoctor({ root = process.cwd(), lockPath = DEFAULT_LOCK_PATH, sourceRoot = null, nativePermissionProfiles = null } = {}) {
  const repositoryRoot = resolve(root);
  const diagnostics = [];
  await inspectWorkflows(repositoryRoot, diagnostics);
  await inspectPermissions(repositoryRoot, diagnostics, nativePermissionProfiles);
  await inspectLock(repositoryRoot, lockPath, sourceRoot, diagnostics);
  await inspectAuthoring(repositoryRoot, diagnostics);
  diagnostics.sort((left, right) => {
    const leftKey = `${left.path}:${left.code}`;
    const rightKey = `${right.path}:${right.code}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const summary = diagnostics.reduce((counts, item) => {
    counts[`${item.severity}s`] += 1;
    return counts;
  }, { errors: 0, warnings: 0, infos: 0 });
  return {
    schema_version: SCHEMA_VERSION,
    root: repositoryRoot,
    passed: summary.errors === 0,
    summary: { errors: summary.errors, warnings: summary.warnings, info: summary.infos },
    diagnostics,
  };
}
