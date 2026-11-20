import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isWithin } from '../eval/util.mjs';
import { AGENT_TIERS } from './agent-config.mjs';

// A skill declares how it runs in the frontmatter of its own document, which is the only place that says so:
//   model_tier: <high_performance|implementation|execution|low_performance>   a sub-agent skill and the setup tier it uses
//   main_session: true                                                          a skill that only runs in the user's session
// The model and effort come from the setup tier (agents.<provider>.<tier>_*); a skill never names a model itself.
export const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const DECLARATION_LINE = /^(model_tier|main_session):[ \t]*(.*?)[ \t]*$/;

export const INTERNAL_SKILL_ROOT = '.harness/skills';
export const LEGACY_INTERNAL_SKILL_ROOT = '.codex/internal-skills';
const PUBLIC_ROOTS = ['.agents/skills', '.codex/skills', '.claude/skills'];
const INTERNAL_SKILL_GROUPS = {
  requirements: [
    'stakeholder-analysis', 'stakeholder-persona', 'grilling', 'grill-with-docs', 'subdomain-candidates',
    'ubiquitous-language', 'event-storming', 'subdomain-classification', 'requirements-fix', 'bounded-context',
  ],
  'design/domain-model': ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary'],
  'design/technical-decisions': ['technology-selection', 'tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data'],
  planning: ['to-ticket', 'plan-review', 'tracker-publish'],
  delivery: ['tactical-code', 'sync-contracts', 'frontend-design', 'frontend-figma', 'frontend-implement', 'frontend-visual-review'],
  quality: [
    'code-review', 'spec-review', 'contract-review', 'review-coordination', 'e2e-test', 'e2e-telemetry',
    'maintain-verification', 'plantuml-diagrams', 'evaluate-harness',
  ],
  operations: [
    'correct', 'diagnosing-bugs', 'gh-open-pr', 'harness-maintenance', 'harness-recover',
    'implementation-guidance', 'testing-guidance', 'victorialogs-local-setup',
  ],
  research: ['code-research', 'knowledge-harvest'],
  workflow: ['workflow-compose', 'worktree-create', 'session-worktree'],
};
const internalGroupsBySkill = new Map(Object.entries(INTERNAL_SKILL_GROUPS)
  .flatMap(([group, skills]) => skills.map((skill) => [skill, group])));

export function internalSkillAssetPath(skill, asset = 'GUIDE.md') {
  const group = internalGroupsBySkill.get(skill);
  return `${INTERNAL_SKILL_ROOT}/${group ? `${group}/` : ''}${skill}/${asset}`;
}

export function internalSkillGuidePaths(skill) {
  const path = internalSkillAssetPath(skill);
  const groupedLegacy = `${LEGACY_INTERNAL_SKILL_ROOT}${path.slice(INTERNAL_SKILL_ROOT.length)}`;
  const flatLegacy = `${LEGACY_INTERNAL_SKILL_ROOT}/${skill}/GUIDE.md`;
  return groupedLegacy === flatLegacy ? [path, flatLegacy] : [path, groupedLegacy, flatLegacy];
}

// Review records may still cite an asset under either layout of the old root.
export function currentInternalSkillAssetPath(path) {
  if (!path.startsWith(`${LEGACY_INTERNAL_SKILL_ROOT}/`)) return path;
  const relative = path.slice(LEGACY_INTERNAL_SKILL_ROOT.length + 1);
  if (relative === 'README.md' || Object.keys(INTERNAL_SKILL_GROUPS).some((group) => relative.startsWith(`${group}/`))) {
    return `${INTERNAL_SKILL_ROOT}/${relative}`;
  }
  const separator = relative.indexOf('/');
  if (separator < 0) return path;
  const skill = relative.slice(0, separator);
  return internalGroupsBySkill.has(skill) ? internalSkillAssetPath(skill, relative.slice(separator + 1)) : path;
}

// Lookup order for one skill's document: the internal GUIDE first, then the installed or source public skill.
export const skillDocumentPaths = (skill) => [...internalSkillGuidePaths(skill), ...PUBLIC_ROOTS.map((directory) => `${directory}/${skill}/SKILL.md`)];

// Returns the declaration in a skill document, or null when it has none. Throws when a declaration is malformed.
export function parseSkillDeclaration(text) {
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) return null;
  const found = {};
  for (const line of block.split(/\r?\n/)) {
    const match = DECLARATION_LINE.exec(line);
    if (!match) continue;
    if (Object.hasOwn(found, match[1])) throw new Error(`${match[1]} is declared twice`);
    found[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const tier = found.model_tier, mainSession = found.main_session;
  if (tier === undefined && mainSession === undefined) return null;
  if (tier !== undefined && mainSession !== undefined) throw new Error('model_tier and main_session cannot both be declared');
  if (tier !== undefined) {
    if (!AGENT_TIERS.includes(tier)) throw new Error(`model_tier must be one of ${AGENT_TIERS.join(', ')}, not "${tier}"`);
    return { model_tier: tier };
  }
  if (mainSession !== 'true') throw new Error(`main_session must be true, not "${mainSession}"`);
  return { main_session: true };
}

// The document text without the Harness declaration lines, so a stage receives the same instructions as before the
// declaration existed; an emptied frontmatter block is dropped with them.
export function stripSkillDeclaration(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  const lines = match[0].split(/(?<=\n)/);
  const kept = lines.filter((line) => !DECLARATION_LINE.test(line.replace(/\r?\n$/, '')));
  if (kept.length === lines.length) return text;
  return `${kept.length > 2 ? kept.join('') : ''}${text.slice(match[0].length)}`;
}

async function regularDocument(root, path) {
  const fullPath = join(root, path);
  const info = await lstat(fullPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isFile()) return null;
  const resolvedPath = await realpath(fullPath);
  if (!isWithin(await realpath(root), resolvedPath)) throw new Error(`Skill document escapes repository root: ${path}`);
  return resolvedPath;
}

async function readDocument(root, path) {
  const fullPath = await regularDocument(root, path);
  return fullPath ? readFile(fullPath, 'utf8') : null;
}

// The declaration of one skill: { skill, path, model_tier } or { skill, path, main_session: true }.
export async function readSkillDeclaration({ root, skill }) {
  if (typeof skill !== 'string' || !SKILL_ID.test(skill)) throw new Error(`Unregistered skill: ${skill}`);
  for (const path of skillDocumentPaths(skill)) {
    const text = await readDocument(root, path);
    if (text === null) continue;
    let declaration;
    try { declaration = parseSkillDeclaration(text); }
    catch (error) { throw new Error(`Invalid model declaration for skill ${skill} in ${path}: ${error.message}`); }
    if (!declaration) throw new Error(`Skill ${skill} declares no model_tier in ${path}; add \`model_tier: <${AGENT_TIERS.join('|')}>\` to its frontmatter`);
    return { skill, path, ...declaration };
  }
  throw new Error(`Unregistered skill: ${skill}`);
}

async function directories(root, path) {
  const entries = await readdir(join(root, path), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  return entries.filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name)).map((entry) => entry.name).sort();
}

// Retained flat GUIDEs stay readable for old installs and projects with custom internal skills.
export async function listInternalSkillGuides(root) {
  const names = new Set([
    ...internalGroupsBySkill.keys(),
    ...await directories(root, INTERNAL_SKILL_ROOT),
    ...await directories(root, LEGACY_INTERNAL_SKILL_ROOT),
  ]);
  const guides = [];
  for (const skill of [...names].sort()) {
    for (const path of internalSkillGuidePaths(skill)) {
      if (!await regularDocument(root, path)) continue;
      guides.push({ skill, path });
      break;
    }
  }
  return guides;
}

// Every skill that declares how it runs, sorted by name. An internal GUIDE is Harness-owned, so a malformed declaration
// there is an error; a public skill directory may belong to the project, so only a valid declaration counts there.
export async function listDeclaredSkills(root) {
  const declared = new Map();
  for (const { skill, path } of await listInternalSkillGuides(root)) {
    const text = await readDocument(root, path);
    if (text === null) continue;
    let declaration;
    try { declaration = parseSkillDeclaration(text); }
    catch (error) { throw new Error(`Invalid model declaration for skill ${skill} in ${path}: ${error.message}`); }
    if (declaration) declared.set(skill, { skill, path, ...declaration });
  }
  for (const directory of PUBLIC_ROOTS) {
    for (const skill of await directories(root, directory)) {
      if (declared.has(skill)) continue;
      const path = `${directory}/${skill}/SKILL.md`;
      const text = await readDocument(root, path);
      if (text === null) continue;
      let declaration = null;
      try { declaration = parseSkillDeclaration(text); } catch { /* a project-owned skill may use these keys differently */ }
      if (declaration) declared.set(skill, { skill, path, ...declaration });
    }
  }
  return [...declared.values()].sort((left, right) => left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0);
}
