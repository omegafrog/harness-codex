import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { parseYaml } from "../eval/yaml.mjs";
import { legacyAgentKeys, runtimeAgentProvider } from '../workflow/agent-config.mjs';
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadHarnessConfig } from "../eval/case-loader.mjs";
import { readHarnessLock, classifyLockEntries, discoverHarnessOwnedFiles, hashFile } from "../installer/lock.mjs";
import { buildHarnessLock, discoverManagedAssetPaths } from "../installer/update.mjs";
import { LEGACY_ASSETS } from '../installer/legacy-assets.mjs';
import { validateContextBudget } from "../workflow/skill-execution.mjs";
import { inspectOrchestratorHook } from '../installer/orchestrator-hook.mjs';
import { WorkflowManifestError, loadWorkflowFile } from "../workflow/loader.mjs";
import { completionKindForWorkflow } from "../workflow/completion.mjs";
import { parseSkillDeclaration } from "../workflow/skill-declaration.mjs";
import { isWithin } from "../eval/util.mjs";
import { IMPLEMENTATION_PR_HEADINGS, IMPLEMENTATION_PR_MANAGED_END, IMPLEMENTATION_PR_MANAGED_START } from "../tracker/authoring.mjs";
import { existingCodexWake } from '../workflow/codex-wake.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_WORKFLOW_DIR = ".codex/workflows";
const DEFAULT_LOCK_PATH = ".codex/harness-lock.json";
const execFileAsync = promisify(execFile);
const PUBLIC_HARNESS_SKILLS = new Set(['orchestrator', 'eli5', 'setup']);

async function inspectPublicSkills(root, diagnostics) {
  const lock = await readHarnessLock(join(root, DEFAULT_LOCK_PATH)).catch(() => null);
  for (const directory of ['.agents/skills', '.claude/skills']) {
    const path = join(root, directory);
    const entries = await readdir(path, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
      if (!entry.isDirectory() || PUBLIC_HARNESS_SKILLS.has(entry.name)) continue;
      const guide = join(path, entry.name, 'SKILL.md');
      const relative = `${directory}/${entry.name}/SKILL.md`;
      const sourcePath = lock?.files?.[relative]?.source_path;
      if ([`.codex/internal-skills/${entry.name}/GUIDE.md`, `.codex/skills/${entry.name}/SKILL.md`].includes(sourcePath)) {
        if (await lstat(guide).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) {
        diagnostics.push(diagnostic('harness_skill_exposed', 'warning', `Internal Harness skill is exposed as a public skill: ${entry.name}`, guide));
        }
      }
    }
  }
}

// Each skill's own document declares the setup tier it runs with. Internal GUIDEs and the Harness public skills are
// Harness-owned, so a malformed declaration there is an error; so is a workflow stage whose skill declares none.
async function inspectSkillDeclarations(root, diagnostics, stageSkills) {
  const candidates = [];
  const internal = join(root, '.codex/internal-skills');
  for (const entry of await readdir(internal, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (entry.isDirectory()) candidates.push({ skill: entry.name, path: join(internal, entry.name, 'GUIDE.md'), stage: false });
  }
  for (const directory of ['.agents/skills', '.claude/skills', '.codex/skills']) for (const name of PUBLIC_HARNESS_SKILLS) candidates.push({ skill: name, path: join(root, directory, name, 'SKILL.md'), stage: false });
  for (const [skill, path] of stageSkills) candidates.push({ skill, path, stage: true });
  // One file can be reached through more than one candidate (a stage skill resolves to its real path).
  const documents = new Map();
  for (const candidate of candidates) {
    const info = await lstat(candidate.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    const key = await realpath(candidate.path);
    documents.set(key, { ...candidate, stage: candidate.stage || documents.get(key)?.stage === true });
  }
  for (const { skill, path, stage } of documents.values()) {
    let declaration;
    try { declaration = parseSkillDeclaration(await readFile(path, 'utf8')); }
    catch (error) {
      diagnostics.push(diagnostic('skill_model_tier_invalid', 'error', `Invalid model declaration for skill ${skill}: ${safeMessage(error, 'unreadable frontmatter')}`, path));
      continue;
    }
    if (!declaration && stage) diagnostics.push(diagnostic('skill_model_tier_missing', 'error', `Workflow stage skill ${skill} declares no model_tier in its document`, path));
  }
}

async function inspectExecutionAssets(root, diagnostics) {
  const config = await loadHarnessConfig(root).catch(() => ({}));
  // The execution contract directory marks a project that installed the stage runtime.
  const contract = await lstat(join(root, '.codex/internal-skills/skill-execution')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!contract) return;
  const paths = [
    '.codex/internal-skills/implement-wrapper/GUIDE.md',
    '.codex/internal-skills/workflow-compose/GUIDE.md',
    '.codex/internal-skills/e2e-test/GUIDE.md',
    '.codex/internal-skills/e2e-test/references/verification-policy.md',
    '.codex/internal-skills/e2e-test/references/failure-learning.md',
    '.codex/agents/tracker_publisher.toml',
    '.codex/agents/pr_author.toml',
    '.codex/internal-skills/skill-execution/GUIDE.md',
    '.codex/internal-skills/skill-execution/references/workflow-map.md',
    '.codex/internal-skills/skill-execution/references/input.md',
    '.codex/internal-skills/skill-execution/worker-base.md',
    '.codex/internal-skills/skill-execution/references/stage-return.md',
    '.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md',
    '.codex/internal-skills/technology-selection/GUIDE.md',
    '.codex/schemas/decision/architecture-decision.schema.yaml',
    '.codex/scripts/harness-publication.mjs',
    '.codex/internal-skills/skill-execution/schemas/input.schema.json',
    '.codex/internal-skills/skill-execution/schemas/return.schema.json',
    '.codex/internal-skills/skill-execution/schemas/workflow-compose-result.schema.json',
    '.codex/internal-skills/skill-execution/schemas/workflow-compose-input.schema.json',
    ...['doctor', 'setup', 'prepare-input', 'compose-workspace', 'output-schema', 'execution-state', 'agent-event', 'agent-admission', 'fresh-agent', 'write-guard', 'contract-review', 'agent-run', 'orchestrator-hook', 'codex-run', 'result', 'workflow-session', 'stage-listen'].map((name) => `.codex/scripts/harness-${name}.mjs`),
    '.codex/internal-skills/skill-execution/schemas/flows/common.schema.json',
    ...['plan-review', 'spec-review'].map((name) => `.codex/internal-skills/skill-execution/schemas/flows/${name}.schema.json`),
  ];
  if (await lstat(join(root, '.harness/src')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) {
    paths.push(...['composer-workspace', 'output-schema', 'stage-commit', 'stage-input', 'skill-execution', 'skill-declaration', 'execution-context', 'codex-process', 'cli-session', 'cli-context', 'user-inputs', 'worktree-stages', 'startup-state', 'stage-result-events', 'providers/index', 'providers/codex', 'contract-review'].map((name) => `.harness/src/workflow/${name}.mjs`));
    paths.push('.harness/src/tracker/publication.mjs', '.harness/src/workflow/setup-answers.mjs', '.harness/src/workflow/codex-wake.mjs');
  }
  if (config.agents?.provider === 'claude-code') {
    paths.push('.claude/skills/orchestrator/SKILL.md', ...['providers/claude-code', 'installer/claude-orchestrator-hook', 'scripts/harness-claude-orchestrator', 'scripts/harness-claude-orchestrator-hook'].map((name) => `.claude/harness/${name}.mjs`));
    for (const profile of await readdir(join(root, '.codex/agents'), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      if (profile.isFile() && profile.name.endsWith('.toml')) paths.push(`.claude/agents/${profile.name.replace(/\.toml$/, '.md')}`);
    }
  }
  for (const path of paths) {
    const fullPath = join(root, path);
    const info = await lstat(fullPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info || !info.isFile() || info.isSymbolicLink()) diagnostics.push(diagnostic('execution_asset_missing', 'error', `Required execution asset is missing or invalid: ${path}`, fullPath));
  }
}

async function inspectLegacyRuntime(root, diagnostics) {
  const path = join(root, '.codex/harness-runtime/src');
  const information = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (information) diagnostics.push(diagnostic('legacy_runtime_present', 'warning', 'Legacy runtime files remain; update Harness to back up and retire locked legacy assets', path));
}

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

async function inspectWorkflows(root, diagnostics, stageSkills) {
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
      if (workflow.id === "to-ticket") {
        const publisher = workflow.stages.find((stage) => stage.id === "tracker-publish");
        if (!publisher || publisher.skill !== "tracker-publish" || publisher.role !== "tracker_publisher") {
          diagnostics.push(diagnostic("tracker_publisher_stage_missing", "error", "to-ticket must declare its dedicated tracker-publish stage and role", path));
        }
      }
      for (const stage of workflow.stages) {
        const profilePath = workflow.references.roles[stage.role];
        const profile = await readContainedRegularFile(root, profilePath, `Agent profile ${stage.role}`);
        const mode = /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(profile)?.[1];
        if (mode === "danger-full-access" && !(workflow.id === "to-ticket" && stage.id === "tracker-publish" && stage.skill === "tracker-publish" && stage.role === "tracker_publisher")) {
          diagnostics.push(diagnostic("dangerous_sandbox_scope", "error", `danger-full-access is not allowed for ${workflow.id}/${stage.id}`, profilePath));
        }
        if (workflow.id === "to-ticket" && stage.id === "tracker-publish" && mode !== "danger-full-access") {
          diagnostics.push(diagnostic("tracker_publisher_sandbox", "error", "tracker-publish requires its declared network and shared Beads write access", profilePath));
        }
      }
      if (workflow.hooks.before_complete.includes("contract_docs") && completionKindForWorkflow(workflow.id) !== "feature_implemented") {
        diagnostics.push(diagnostic("completion_gate_scope", "warning", `Workflow ${workflow.id} declares contract_docs, but this completion scope ignores that gate`, path, { completion_kind: completionKindForWorkflow(workflow.id) }));
      }
      for (const stage of workflow.stages) stageSkills.set(stage.skill, workflow.references.skills[stage.skill]);
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
    // Eval permission_profile is an event label; resolveCodexCommand uses explicit sandbox/network flags.
    const previous = definitions.get(profile.permission_profile);
    if (previous && previous.signature !== signature) {
      diagnostics.push(diagnostic("permission_conflict", "error", `Native permission profile ${profile.permission_profile} has conflicting environment definitions`, path, { profiles: [previous.name, name] }));
    } else if (!previous) {
      definitions.set(profile.permission_profile, { name, signature });
    }
  }
  const command = config.eval.codex?.command || [];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) {
    diagnostics.push(diagnostic("permission_conflict", "error", "Codex command must be an argv list", configPath));
    return;
  }
  for (let index = 0; index < command.length; index++) {
    const flag = command[index];
    if (flag !== "--permission-profile" && flag !== "-P" && !flag.startsWith("--permission-profile=")) continue;
    const name = flag.startsWith("--permission-profile=") ? flag.slice("--permission-profile=".length) : command[++index];
    if (typeof name !== "string" || !name.trim() || name.startsWith("-")) {
      diagnostics.push(diagnostic("permission_conflict", "error", "Codex permission profile flag requires a name", configPath));
      continue;
    }
    if (!references.has(name)) references.set(name, []);
    references.get(name).push(`${configPath}#eval.codex.command`);
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
    const installedFiles = new Set(await discoverHarnessOwnedFiles(root));
    // Project-owned scripts may live beside Harness scripts; Git tracking does not make them managed assets.
    const trackedScripts = new Set((await execFileAsync('git', ['-C', root, 'ls-files', '-z', '--', '.codex/scripts'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))).stdout.split('\0').filter(Boolean));
    const managedPaths = sourceRoot ? new Set(await discoverManagedAssetPaths(sourceRoot)) : installedFiles;
    const currentAssets = sourceRoot ? (await buildHarnessLock({ sourceRoot, targetRoot: root })).files : {};
    // A divergent, unregistered agent profile was preserved as consumer-owned during install.
    const preservedAgentProfile = (file) => file.startsWith(".codex/agents/") && !lock.files[file]
      && currentAssets[file] && currentAssets[file].installed_sha256 !== currentAssets[file].upstream_sha256;
    const ownedFiles = new Set([...installedFiles].filter((file) => file !== '.codex/harness.yaml' && managedPaths.has(file)
      && (lock.files[file] || !trackedScripts.has(file))
      && !preservedAgentProfile(file)));
    const lockEntries = entries.filter((entry) => entry.path !== ".codex/harness.yaml");
    const lockedFiles = new Set(lockEntries.map((entry) => entry.path));
    for (const path of ownedFiles) if (!lockedFiles.has(path)) {
      const critical = ['.harness/src/workflow/project-readiness.mjs', '.harness/src/workflow/skill-execution.mjs', '.harness/src/workflow/providers/index.mjs', '.harness/src/workflow/providers/codex.mjs', '.harness/src/workflow/providers/claude-code.mjs', '.codex/scripts/harness-agent-run.mjs', '.codex/scripts/harness-agent-admission.mjs', '.codex/scripts/harness-codex-run.mjs'].includes(path) || path.startsWith('.claude/agents/') || path.startsWith('.claude/skills/');
      diagnostics.push(diagnostic("installer_unlocked_file", critical ? "error" : "warning", `Harness-owned file is not present in harness-lock.json: ${path}`, resolve(root, path)));
    }
    for (const entry of lockEntries) {
      if (lock.files[entry.path].retired || (sourceRoot && !managedPaths.has(entry.path))) {
        diagnostics.push(diagnostic('installer_retired_file', 'warning', `Retired Harness file remains: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
        continue;
      }
      if (entry.status === "conflict") diagnostics.push(diagnostic("installer_conflict", "error", `Harness file changed locally and upstream: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      else if (entry.status === "locally_modified") diagnostics.push(diagnostic("installer_locally_modified", "warning", `Harness file was modified locally: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      else if (entry.status === "upstream_updated") diagnostics.push(diagnostic("installer_upstream_updated", "info", `Harness file has an upstream update: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      if (entry.current_sha256 === null) diagnostics.push(diagnostic("installer_missing_file", "error", `Locked harness file is missing: ${entry.path}`, resolve(root, entry.path), { lock_status: entry.status }));
      if (entry.source_missing) diagnostics.push(diagnostic("installer_source_missing", "error", `Locked upstream source file is missing: ${entry.source_path}`, resolve(root, entry.path), { source_path: entry.source_path }));
      if (!ownedFiles.has(entry.path)) diagnostics.push(diagnostic("installer_stale_lock_entry", "warning", `Lock entry is no longer an installed harness file: ${entry.path}`, resolve(root, entry.path)));
    }
    for (const legacy of LEGACY_ASSETS.filter((item) => item.action === 'retire' && !lock.files[item.path])) {
      const path = resolve(root, legacy.path);
      const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || !isWithin(await realpath(root), await realpath(path))) throw new Error(`Invalid legacy asset path: ${legacy.path}`);
      const hash = await hashFile(path);
      if (hash === legacy.sha256) diagnostics.push(diagnostic('installer_retired_file', 'warning', `Known retired Harness file remains: ${legacy.path}`, path));
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
  const planTemplatePath = join(githubDirectory, "PULL_REQUEST_TEMPLATE/plan-set.md");
  const planTemplate = await readFile(planTemplatePath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (planTemplate === null) diagnostics.push(diagnostic('plan_pr_template_missing', 'error', 'Managed plan-set pull request template is missing', planTemplatePath));
  else {
    for (const heading of ['Plan Set', 'Execution Order', 'Specifications', 'Planning Validation', 'Remaining Work']) {
      if (!new RegExp(`^## ${heading}$`, 'm').test(planTemplate)) diagnostics.push(diagnostic('plan_pr_template_invalid', 'error', `Plan-set pull request template is missing section: ${heading}`, planTemplatePath));
    }
    if (/^\s*(?:Closes|Fixes|Resolves) #/mi.test(planTemplate)) diagnostics.push(diagnostic('plan_pr_template_invalid', 'error', 'Plan-set pull request template cannot close issues', planTemplatePath));
  }
}

export async function runDoctor({ root = process.cwd(), lockPath = DEFAULT_LOCK_PATH, sourceRoot = null, nativePermissionProfiles = null } = {}) {
  const repositoryRoot = resolve(root);
  const diagnostics = [];
  await inspectPublicSkills(repositoryRoot, diagnostics);
  const git = async (args) => {
    try { return { status: 0, ...(await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' })) }; }
    catch (error) { return { status: typeof error.code === 'number' ? error.code : null, stdout: error.stdout || '' }; }
  };
  const gitRoot = await git(['rev-parse', '--show-toplevel']);
  if (gitRoot.status === 0 && resolve(gitRoot.stdout.trim()) === repositoryRoot) {
    const ignored = await git(['check-ignore', '--no-index', '-q', '.io/worktree.json']);
    if (ignored.status !== 0) diagnostics.push(diagnostic('runtime_not_ignored', 'error', 'Harness workflow session files are not ignored by Git', join(repositoryRoot, '.io')));
    const inputIgnored = await git(['check-ignore', '--no-index', '-q', '.io/probe/skill/execution/input.json']);
    if (inputIgnored.status !== 0) diagnostics.push(diagnostic('execution_input_not_ignored', 'error', 'Harness execution inputs are not ignored by Git', join(repositoryRoot, '.io')));
  }
  const hookScript = join(repositoryRoot, '.codex/scripts/harness-orchestrator-hook.mjs');
  if (await lstat(hookScript).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) {
    try {
      const hook = await inspectOrchestratorHook(repositoryRoot);
      const userHook = !hook.valid && await (await import('../workflow/providers/codex.mjs')).codexUserOrchestratorHookInstalled().catch(() => false);
      if (!hook.valid && !userHook) diagnostics.push(diagnostic('orchestrator_hook_missing', 'error', hook.reason, hook.path));
    } catch (error) {
      diagnostics.push(diagnostic('orchestrator_hook_invalid', 'error', safeMessage(error, 'Invalid orchestrator hook'), join(repositoryRoot, '.codex/hooks.json')));
    }
  }
  // Model settings live under agents.<provider>; older flat keys must be moved by update or setup.
  const agentConfig = await readFile(join(repositoryRoot, '.codex/harness.yaml'), 'utf8').then((text) => parseYaml(text), () => null);
  const flatAgentKeys = agentConfig ? legacyAgentKeys(agentConfig) : [];
  if (flatAgentKeys.length) diagnostics.push(diagnostic('agents_config_flat', 'error', `agents.${flatAgentKeys[0]} is a flat key; run harness-codex update to move the model settings under agents.${agentConfig.agents?.provider || 'codex'}`, join(repositoryRoot, '.codex/harness.yaml')));
  if (await loadHarnessConfig(repositoryRoot).then((config) => (runtimeAgentProvider() || config.agents?.provider || 'codex') === 'codex', () => false)) {
    try {
      if (!await existingCodexWake(repositoryRoot)) throw new Error('Wake MCP is not enabled');
    } catch {
      diagnostics.push(diagnostic('codex_wake_unavailable', 'warning', 'Existing Codex Wake MCP is unavailable; use harness-stage-listen to retrieve stage results.', null));
    }
    try {
      const { inspectCodexHookTrust } = await import('../workflow/providers/codex.mjs');
      const trust = await inspectCodexHookTrust();
      if (trust.orchestrator_hook !== 'trusted') diagnostics.push(diagnostic('codex_orchestrator_hook_untrusted', 'warning', trust.orchestrator_hook === 'missing' ? 'Harness orchestrator user hook is missing from the Codex user hooks; run setup with the codex provider so new worktrees need no hook review' : 'Harness orchestrator user hook is not trusted; run /hooks in Codex and trust "Running Harness orchestrator hook" once for all worktrees', null));
      if (trust.fresh_agent_check !== 'trusted') diagnostics.push(diagnostic('codex_fresh_agent_hook_untrusted', 'warning', trust.fresh_agent_check === 'missing' ? 'Harness fresh-agent hook is missing from the Codex user hooks; run setup with the codex provider' : 'Harness fresh-agent hook is not trusted; run /hooks in Codex and trust "Checking Harness fresh agent" (PreToolUse) so forked reviewers are refused before they start', null));
      if (trust.write_guard !== 'trusted') diagnostics.push(diagnostic('codex_write_guard_hook_untrusted', 'warning', trust.write_guard === 'missing' ? 'Harness write-guard hook is missing from the Codex user hooks; run setup with the codex provider so the orchestrator main session cannot edit product code, tests or contracts' : 'Harness write-guard hook is not trusted; run /hooks in Codex and trust "Guarding Harness orchestrator writes" (PreToolUse) so the orchestrator main session cannot edit product code, tests or contracts', null));
      if (!trust.trusted) diagnostics.push(diagnostic('codex_subagent_hook_untrusted', 'warning', trust.missing.length ? 'Harness subagent hook is missing from the Codex user hooks; run setup with the codex provider' : 'Harness subagent hook is not trusted; run /hooks in Codex and trust "Recording Harness subagent". Codex stages will not start until then.', trust.hooks_path, { missing: trust.missing, untrusted: trust.untrusted }));
    } catch (error) {
      diagnostics.push(diagnostic('codex_subagent_hook_invalid', 'warning', safeMessage(error, 'Invalid Codex user hooks'), null));
    }
  }
  if (await loadHarnessConfig(repositoryRoot).then((config) => config.agents?.provider === 'claude-code', () => false)) {
    try {
      const { inspectClaudeOrchestratorHook } = await import('../../../.claude/harness/installer/claude-orchestrator-hook.mjs').catch((error) => { throw error.code === 'ERR_MODULE_NOT_FOUND' ? new Error('agents.provider is claude-code but the Claude provider is not installed; install with --provider claude-code or all') : error; });
      const hook = await inspectClaudeOrchestratorHook(repositoryRoot);
      if (!hook.valid) diagnostics.push(diagnostic('claude_orchestrator_hook_missing', 'error', hook.reason, hook.path));
    } catch (error) {
      diagnostics.push(diagnostic('claude_orchestrator_hook_invalid', 'error', safeMessage(error, 'Invalid Claude Code orchestrator hook'), join(repositoryRoot, '.claude/settings.local.json')));
    }
  }
  const budgetPath = join(repositoryRoot, '.codex/context-budget.json');
  try {
    const information = await lstat(budgetPath);
    if (!information.isFile()) throw new Error('Context budget must be a regular file');
    validateContextBudget(JSON.parse(await readFile(budgetPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') diagnostics.push(diagnostic('context_budget_invalid', 'error', safeMessage(error, 'Invalid context budget'), budgetPath));
  }
  const stageSkills = new Map();
  await inspectWorkflows(repositoryRoot, diagnostics, stageSkills);
  await inspectSkillDeclarations(repositoryRoot, diagnostics, stageSkills);
  await inspectPermissions(repositoryRoot, diagnostics, nativePermissionProfiles);
  await inspectLock(repositoryRoot, lockPath, sourceRoot, diagnostics);
  await inspectLegacyRuntime(repositoryRoot, diagnostics);
  await inspectExecutionAssets(repositoryRoot, diagnostics);
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
