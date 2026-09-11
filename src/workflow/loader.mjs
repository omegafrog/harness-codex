import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DEFAULT_HOOK_CHECKS, LifecycleGateRegistry } from "../gates/lifecycle.mjs";
import { parseYaml } from "../eval/yaml.mjs";
import { isWithin } from "../eval/util.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKFLOW_HOOKS = Object.freeze(Object.keys(DEFAULT_HOOK_CHECKS));
const WORKFLOW_FIELDS = new Set(["schema_version", "id", "roles", "skills", "hooks", "stages"]);
const STAGE_FIELDS = new Set(["id", "role", "skill", "needs", "condition", "gates"]);
export const WORKFLOW_STAGE_GATE_IDS = new Set([
  "product_coverage",
  "material_ambiguity_resolved",
  "product_diagram_completion",
  "architecture_coverage",
  "architecture_diagram_completion",
]);
export const WORKFLOW_STAGE_CONDITION_IDS = new Set([
  "product_diagram_required",
  "architecture_diagram_required",
]);

export const DEFAULT_WORKFLOW_DIR = ".codex/workflows";
export const DEFAULT_AGENT_DIR = ".codex/agents";
export const DEFAULT_SKILL_DIR = ".agents/skills";
export const LEGACY_SKILL_DIR = ".codex/skills";

export class WorkflowManifestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkflowManifestError";
    this.reason = "invalid_workflow_manifest";
    this.details = details;
  }
}

function asObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowManifestError(`${path} must be an object`);
  return value;
}

function asString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new WorkflowManifestError(`${path} must be a non-empty string`);
  return value;
}

function safeErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  try {
    const message = String(error);
    return message || fallback;
  } catch {
    return fallback;
  }
}

function asId(value, path) {
  const id = asString(value, path);
  if (!SAFE_ID.test(id)) throw new WorkflowManifestError(`${path} must be a safe identifier`);
  return id;
}

function asList(value, path, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new WorkflowManifestError(`${path} must be a ${allowEmpty ? "list" : "non-empty list"}`);
  return value;
}

function asIdList(value, path, { allowEmpty = false } = {}) {
  const ids = asList(value, path, { allowEmpty }).map((item, index) => asId(item, `${path}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new WorkflowManifestError(`${path} must not contain duplicate identifiers`);
  return ids;
}

function rejectUnknownFields(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new WorkflowManifestError(`${path}.${unknown} is not supported by the workflow contract`);
}

function validateHookConfiguration(rawHooks, registry, path = "hooks") {
  const hooks = asObject(rawHooks, path);
  const names = Object.keys(hooks);
  const unknownHook = names.find((hook) => !WORKFLOW_HOOKS.includes(hook));
  if (unknownHook) throw new WorkflowManifestError(`${path}.${unknownHook} is not a supported lifecycle hook`);
  const normalized = {};
  for (const hook of WORKFLOW_HOOKS) {
    const checks = asList(hooks[hook] ?? [], `${path}.${hook}`, { allowEmpty: true });
    if (new Set(checks).size !== checks.length) throw new WorkflowManifestError(`${path}.${hook} must not contain duplicate checks`);
    const unknownCheck = checks.find((check) => typeof check !== "string" || !registry.checks.has(check));
    if (unknownCheck) throw new WorkflowManifestError(`Unknown lifecycle check in ${path}.${hook}: ${unknownCheck}`);
    normalized[hook] = [...checks];
  }
  return normalized;
}

function validateStages(rawStages) {
  const stages = asList(rawStages, "stages");
  const seen = new Set();
  const normalized = stages.map((rawStage, index) => {
    const path = `stages[${index}]`;
    const stage = asObject(rawStage, path);
    rejectUnknownFields(stage, STAGE_FIELDS, path);
    const id = asId(stage.id, `${path}.id`);
    if (seen.has(id)) throw new WorkflowManifestError(`Duplicate stage id: ${id}`);
    seen.add(id);
    const needs = asIdList(stage.needs ?? [], `${path}.needs`, { allowEmpty: true });
    if (needs.includes(id)) throw new WorkflowManifestError(`${path}.needs cannot contain itself: ${id}`);
    const condition = stage.condition === undefined ? null : asId(stage.condition, `${path}.condition`);
    if (condition && !WORKFLOW_STAGE_CONDITION_IDS.has(condition)) throw new WorkflowManifestError(`Unknown stage condition: ${condition}`);
    const gates = asIdList(stage.gates ?? [], `${path}.gates`, { allowEmpty: true });
    const unknownGate = gates.find((gate) => !WORKFLOW_STAGE_GATE_IDS.has(gate));
    if (unknownGate) throw new WorkflowManifestError(`Unknown stage gate: ${unknownGate}`);
    return {
      ...stage,
      id,
      role: asId(stage.role, `${path}.role`),
      skill: asId(stage.skill, `${path}.skill`),
      needs,
      ...(condition === null ? {} : { condition }),
      gates,
    };
  });

  const stageIds = new Set(normalized.map((stage) => stage.id));
  for (const stage of normalized) {
    const unknown = stage.needs.find((dependency) => !stageIds.has(dependency));
    if (unknown) throw new WorkflowManifestError(`Unknown stage dependency: ${stage.id} -> ${unknown}`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (stage) => {
    if (visiting.has(stage.id)) throw new WorkflowManifestError(`cyclic stage dependency: ${stage.id}`);
    if (visited.has(stage.id)) return;
    visiting.add(stage.id);
    for (const dependency of stage.needs) visit(normalized.find((candidate) => candidate.id === dependency));
    visiting.delete(stage.id);
    visited.add(stage.id);
  };
  normalized.forEach(visit);
  return normalized;
}

export function validateWorkflowDocument(raw, { registry = new LifecycleGateRegistry() } = {}) {
  if (!registry || !(registry.checks instanceof Map)) throw new WorkflowManifestError("workflow gate registry is invalid");
  const document = asObject(raw, "workflow");
  rejectUnknownFields(document, WORKFLOW_FIELDS, "workflow");
  if (document.schema_version !== 1) throw new WorkflowManifestError("workflow.schema_version must be 1");
  const id = asId(document.id, "workflow.id");
  const roles = asIdList(document.roles, "workflow.roles");
  const skills = asIdList(document.skills, "workflow.skills");
  const hooks = validateHookConfiguration(document.hooks, registry);
  const stages = validateStages(document.stages);
  const roleSet = new Set(roles);
  const skillSet = new Set(skills);
  for (const stage of stages) {
    if (!roleSet.has(stage.role)) throw new WorkflowManifestError(`Stage ${stage.id} references undeclared role: ${stage.role}`);
    if (!skillSet.has(stage.skill)) throw new WorkflowManifestError(`Stage ${stage.id} references undeclared skill: ${stage.skill}`);
  }
  return {
    ...document,
    schema_version: 1,
    id,
    roles,
    skills,
    hooks,
    stages,
  };
}

function resolveContained(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new WorkflowManifestError(`${label} must be a non-empty path`);
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate)) throw new WorkflowManifestError(`${label} escapes repository root: ${relativePath}`);
  return candidate;
}

async function resolveRegularFile(root, candidate, label) {
  const lexicalPath = resolveContained(root, candidate, label);
  let resolvedRoot;
  let resolvedPath;
  try {
    resolvedRoot = await realpath(root);
    resolvedPath = await realpath(lexicalPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new WorkflowManifestError(`Unable to resolve ${label}: ${candidate}`, { path: lexicalPath, cause: error });
  }
  if (!isWithin(resolvedRoot, resolvedPath)) throw new WorkflowManifestError(`${label} escapes repository root: ${candidate}`, { path: resolvedPath });
  const information = await stat(resolvedPath).catch((error) => {
    throw new WorkflowManifestError(`Unable to inspect ${label}: ${candidate}`, { path: resolvedPath, cause: error });
  });
  if (!information.isFile()) throw new WorkflowManifestError(`${label} must be a regular file: ${candidate}`, { path: resolvedPath });
  return resolvedPath;
}

async function resolveReferences(workflow, { root, agentDir, skillDir, legacySkillDir }) {
  const roles = {};
  const skills = {};
  for (const role of workflow.roles) {
    const path = await resolveRegularFile(root, join(agentDir, `${role}.toml`), `Role profile ${role}`);
    if (!path) throw new WorkflowManifestError(`Missing role profile: ${role}`, { path: resolve(root, join(agentDir, `${role}.toml`)) });
    roles[role] = path;
  }
  for (const skill of workflow.skills) {
    const canonicalPath = await resolveRegularFile(root, join(skillDir, skill, "SKILL.md"), `Skill ${skill}`);
    if (canonicalPath) {
      skills[skill] = canonicalPath;
      continue;
    }
    const legacyPath = await resolveRegularFile(root, join(legacySkillDir, skill, "SKILL.md"), `Skill ${skill}`);
    if (!legacyPath) throw new WorkflowManifestError(`Missing skill: ${skill}`, { path: resolve(root, join(skillDir, skill, "SKILL.md")) });
    skills[skill] = legacyPath;
  }
  return { roles, skills };
}

export function loadWorkflowText(text, options = {}) {
  if (typeof text !== "string") throw new WorkflowManifestError("workflow text must be a string");
  let raw;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new WorkflowManifestError(`Unable to parse workflow YAML: ${safeErrorMessage(error, "unknown YAML error")}`, { cause: error });
  }
  return validateWorkflowDocument(raw, options);
}

export async function loadWorkflowFile(filePath, {
  root = process.cwd(),
  agentDir = DEFAULT_AGENT_DIR,
  skillDir = DEFAULT_SKILL_DIR,
  legacySkillDir = LEGACY_SKILL_DIR,
  ...options
} = {}) {
  const repositoryRoot = resolve(root);
  const path = resolveContained(repositoryRoot, filePath, "Workflow file");
  const canonicalDirectory = resolveContained(repositoryRoot, DEFAULT_WORKFLOW_DIR, "Workflow directory");
  if (!isWithin(canonicalDirectory, path)) throw new WorkflowManifestError(`Workflow file must be under ${DEFAULT_WORKFLOW_DIR}: ${filePath}`);
  const canonicalDirectoryInfo = await lstat(canonicalDirectory).catch((error) => {
    throw new WorkflowManifestError(`Unable to inspect canonical workflow directory: ${canonicalDirectory}`, { path: canonicalDirectory, cause: error });
  });
  if (canonicalDirectoryInfo.isSymbolicLink()) throw new WorkflowManifestError(`Canonical workflow directory cannot be a symlink: ${DEFAULT_WORKFLOW_DIR}`, { path: canonicalDirectory });
  if (!canonicalDirectoryInfo.isDirectory()) throw new WorkflowManifestError(`Canonical workflow directory must be a directory: ${DEFAULT_WORKFLOW_DIR}`, { path: canonicalDirectory });
  const resolvedPath = await resolveRegularFile(repositoryRoot, path, "Workflow file");
  if (!resolvedPath) throw new WorkflowManifestError(`Workflow file not found: ${path}`, { path });
  const canonicalRealDirectory = await realpath(canonicalDirectory).catch((error) => {
    throw new WorkflowManifestError(`Unable to resolve canonical workflow directory: ${canonicalDirectory}`, { path: canonicalDirectory, cause: error });
  });
  if (!isWithin(canonicalRealDirectory, resolvedPath)) throw new WorkflowManifestError(`Workflow file resolves outside ${DEFAULT_WORKFLOW_DIR}: ${filePath}`, { path: resolvedPath });
  let text;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new WorkflowManifestError(`Unable to read workflow file: ${resolvedPath}: ${safeErrorMessage(error, "unknown read error")}`, { path: resolvedPath, cause: error });
  }
  const workflow = loadWorkflowText(text, options);
  return {
    ...workflow,
    path: resolvedPath,
    references: await resolveReferences(workflow, { root: repositoryRoot, agentDir, skillDir, legacySkillDir }),
  };
}

export async function loadNamedWorkflow(name, {
  root = process.cwd(),
  workflowDir = DEFAULT_WORKFLOW_DIR,
  ...options
} = {}) {
  if (workflowDir !== DEFAULT_WORKFLOW_DIR) throw new WorkflowManifestError(`Canonical workflow directory is ${DEFAULT_WORKFLOW_DIR}`);
  const id = asId(asString(name, "workflow name").replace(/\.ya?ml$/i, ""), "workflow name");
  const repositoryRoot = resolve(root);
  const directory = resolveContained(repositoryRoot, DEFAULT_WORKFLOW_DIR, "Workflow directory");
  return loadWorkflowFile(join(directory, `${id}.yaml`), { root: repositoryRoot, ...options });
}
