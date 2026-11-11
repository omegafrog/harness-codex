import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_TIERS } from './agent-config.mjs';

// A skill declares how it runs in the frontmatter of its own document, which is the only place that says so:
//   model_tier: <high_performance|implementation|execution|low_performance>   a sub-agent skill and the setup tier it uses
//   main_session: true                                                          a skill that only runs in the user's session
// The model and effort come from the setup tier (agents.<provider>.<tier>_*); a skill never names a model itself.
export const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const DECLARATION_LINE = /^(model_tier|main_session):[ \t]*(.*?)[ \t]*$/;

const INTERNAL_ROOT = '.codex/internal-skills';
const PUBLIC_ROOTS = ['.agents/skills', '.codex/skills', '.claude/skills'];

// Lookup order for one skill's document: the internal GUIDE first, then the installed or source public skill.
export const skillDocumentPaths = (skill) => [`${INTERNAL_ROOT}/${skill}/GUIDE.md`, ...PUBLIC_ROOTS.map((directory) => `${directory}/${skill}/SKILL.md`)];

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

async function readDocument(root, path) {
  const info = await lstat(join(root, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink() || !info.isFile()) return null;
  return readFile(join(root, path), 'utf8');
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

// Every skill that declares how it runs, sorted by name. An internal GUIDE is Harness-owned, so a malformed declaration
// there is an error; a public skill directory may belong to the project, so only a valid declaration counts there.
export async function listDeclaredSkills(root) {
  const declared = new Map();
  for (const skill of await directories(root, INTERNAL_ROOT)) {
    const path = `${INTERNAL_ROOT}/${skill}/GUIDE.md`;
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
