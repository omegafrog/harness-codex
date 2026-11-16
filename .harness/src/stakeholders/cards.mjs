// Stakeholder cards are project-owned Markdown files the user registers with `harness-stakeholder.mjs`.
// The stakeholder-analysis stage reads them as persona inputs; it never creates or edits them.
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';

export const STAKEHOLDER_DIRECTORY = 'docs/domain/stakeholders';
export const STAKEHOLDER_KINDS = ['person', 'constraint-source'];
export const LIST_FIELDS = ['goals', 'pain_points', 'constraints', 'vocabulary', 'knowledge_boundary', 'evidence'];
export const TEXT_FIELDS = ['role', 'authority'];
export const UNKNOWN = 'UNKNOWN';
const ID = /^SH-(\d{2,})$/;
const FIELD_ORDER = ['id', 'kind', 'role', 'goals', 'pain_points', 'constraints', 'authority', 'vocabulary', 'knowledge_boundary', 'evidence'];

export class StakeholderCardError extends Error {}

const fail = (message) => { throw new StakeholderCardError(message); };
const text = (value) => typeof value === 'string' && value.trim() !== '';

// Returns a normalized card or throws with the first problem a user can fix in the file.
export function validateCard(card, { fileName = null } = {}) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) fail('Card frontmatter must be a mapping');
  const unknownKeys = Object.keys(card).filter((key) => !FIELD_ORDER.includes(key));
  if (unknownKeys.length) fail(`Unknown card field: ${unknownKeys[0]}`);
  if (!ID.test(card.id || '')) fail('id must look like SH-01');
  if (fileName && fileName !== `${card.id}.md`) fail(`File name must match id: ${card.id}.md`);
  const kind = card.kind ?? 'person';
  if (!STAKEHOLDER_KINDS.includes(kind)) fail(`kind must be one of ${STAKEHOLDER_KINDS.join(', ')}`);
  if (!text(card.role) || card.role === UNKNOWN) fail('role is required');
  const normalized = { id: card.id, kind, role: card.role.trim() };
  for (const field of LIST_FIELDS) {
    const value = card[field] ?? [];
    if (!Array.isArray(value) || !value.every(text)) fail(`${field} must be a list of non-empty strings`);
    normalized[field] = value.map((item) => item.trim()).filter((item) => item !== UNKNOWN);
  }
  if (!normalized.goals.length) fail('goals needs at least one entry');
  const authority = card.authority ?? UNKNOWN;
  if (!text(authority)) fail('authority must be a non-empty string or UNKNOWN');
  normalized.authority = authority.trim();
  return normalized;
}

export function parseCard(source, options = {}) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) fail('Card must start with a --- frontmatter block');
  let data;
  try { data = parseYaml(match[1]); } catch (error) { fail(`Invalid frontmatter: ${error.message}`); }
  return { card: validateCard(data, options), notes: match[2].replace(/^\s*#[^\n]*\n?/, '').trim() };
}

const quote = (value) => JSON.stringify(value);

export function formatCard(card, notes = '') {
  const normalized = validateCard(card);
  const lines = ['---'];
  for (const field of FIELD_ORDER) {
    const value = normalized[field];
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${field}: []`);
      else lines.push(`${field}:`, ...value.map((item) => `  - ${quote(item)}`));
    } else lines.push(`${field}: ${field === 'id' || field === 'kind' ? value : quote(value)}`);
  }
  lines.push('---', '', `# ${normalized.id} ${normalized.role.replace(/\s+/g, ' ')}`, '');
  if (notes.trim()) lines.push(notes.trim(), '');
  return `${lines.join('\n')}`;
}

async function directoryEntries(root) {
  const directory = join(root, STAKEHOLDER_DIRECTORY);
  const info = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${STAKEHOLDER_DIRECTORY} must be a real directory`);
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith('.md') && entry.name !== 'README.md').sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// Lists every card file; invalid ones are reported instead of hiding them, so the user can fix the file.
export async function readRegistry(root) {
  const cards = [], problems = [];
  for (const entry of await directoryEntries(root)) {
    const path = `${STAKEHOLDER_DIRECTORY}/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink()) { problems.push({ path, message: 'Card must be a regular file' }); continue; }
    try { cards.push({ path, ...parseCard(await readFile(join(root, path), 'utf8'), { fileName: entry.name }) }); }
    catch (error) {
      if (!(error instanceof StakeholderCardError)) throw error;
      problems.push({ path, message: error.message });
    }
  }
  cards.sort((a, b) => a.card.id.localeCompare(b.card.id, 'en', { numeric: true }));
  return { cards, problems };
}

export async function nextCardId(root) {
  let highest = 0;
  for (const entry of await directoryEntries(root)) {
    const number = ID.exec(entry.name.replace(/\.md$/, ''))?.[1];
    if (number) highest = Math.max(highest, Number(number));
  }
  return `SH-${String(highest + 1).padStart(2, '0')}`;
}

const cardPath = (root, id) => {
  if (!ID.test(id || '')) fail('id must look like SH-01');
  return join(root, STAKEHOLDER_DIRECTORY, `${id}.md`);
};

export async function readCard(root, id) {
  const source = await readFile(cardPath(root, id), 'utf8').catch((error) => error.code === 'ENOENT' ? fail(`No stakeholder card ${id}`) : Promise.reject(error));
  return parseCard(source, { fileName: `${id}.md` });
}

export async function writeCard(root, card, notes = '', { create = false } = {}) {
  const path = cardPath(root, card.id);
  const contents = formatCard(card, notes);
  await mkdir(join(root, STAKEHOLDER_DIRECTORY), { recursive: true });
  await writeFile(path, contents, { flag: create ? 'wx' : 'w' }).catch((error) => error.code === 'EEXIST' ? fail(`Stakeholder card ${card.id} already exists`) : Promise.reject(error));
  return `${STAKEHOLDER_DIRECTORY}/${card.id}.md`;
}

// A card that no longer parses can still be removed, so the user is never stuck with a broken file.
export async function removeCard(root, id) {
  const path = cardPath(root, id);
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? fail(`No stakeholder card ${id}`) : Promise.reject(error));
  if (!info.isFile() || info.isSymbolicLink()) fail('Card must be a regular file');
  await rm(path);
  return `${STAKEHOLDER_DIRECTORY}/${id}.md`;
}
