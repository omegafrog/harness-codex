import { execFileSync } from 'node:child_process';
import { implementedTickets } from '../workflow/tactical-tickets.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { domainIndexChanges } from './index.mjs';
import { readDomainFile, removeDomainIndex, writeDomainFile } from './repository.mjs';
import { domainDocumentPath, formatDomainDocument } from './schema.mjs';
import { loadDomainSnapshot } from './search.mjs';
import { validateDomainGraph } from './validation.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const readOptional = (root, path) => readDomainFile(root, path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const TYPES = { BIZ: 'biz', INV: 'rule', EX: 'exception', AC: null, EVT: 'event', POL: 'policy', TRN: 'transition', SD: 'subdomain' };
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isDomainSyncStage = (skill) => ['bounded-context', 'domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary'].includes(skill);
export const domainSyncPath = (id) => `runtime/executions/${id}/domain-sync.json`;
const specPath = (id, file) => {
  if (!PLAN_ID.test(id || '')) throw new Error('Invalid domain sync Plan Set ID');
  return `docs/specs/${id}/${file}`;
};

function verifyLinks(requirements, links, entries) {
  if (!links || typeof links !== 'object' || Array.isArray(links)) throw new Error('Domain links must be a mapping');
  for (const [local, id] of Object.entries(links)) {
    const match = /^(BIZ|INV|EX|AC|EVT|POL|TRN|SD)-\d+$/.exec(local);
    if (!match || !new RegExp(`\\b${local}\\b`).test(requirements)) throw new Error(`Unknown requirements ID: ${local}`);
    const definition = entries.get(id)?.metadata;
    if (!definition || definition.status === 'retired' || (TYPES[match[1]] && definition.kind !== TYPES[match[1]])) throw new Error(`Invalid domain target for ${local}: ${id}`);
  }
}

export async function planDomainSync(root, planSetId, proposal) {
  const requirementsPath = specPath(planSetId, 'requirements.md');
  const linksPath = specPath(planSetId, 'domain-links.json');
  const requirements = await readDomainFile(root, requirementsPath);
  if (!/^- 상태: fixed\s*$/m.test(requirements)) throw new Error('Domain sync requires fixed requirements');
  if (!proposal || proposal.schema_version !== 1 || !Array.isArray(proposal.changes) || !Object.hasOwn(proposal, 'links')) throw new Error('Invalid domain sync proposal');
  const snapshot = await loadDomainSnapshot(root);
  const entries = new Map(snapshot.documents.map((entry) => [entry.metadata.id, entry]));
  const originals = new Map(entries);
  const touched = new Set();
  const changes = [];
  for (const change of proposal.changes) {
    const { operation, id, document, reason } = change;
    const old = originals.get(id);
    if (typeof id !== 'string' || touched.has(id)) throw new Error(`Duplicate or invalid domain change: ${id}`);
    touched.add(id);
    if (operation === 'reuse') {
      if (!old || old.metadata.status === 'retired' || document) throw new Error(`Invalid reuse: ${id}`);
      continue;
    }
    if (!['create', 'extend', 'modify', 'retire', 'relocate', 'implement'].includes(operation)) throw new Error(`Invalid domain operation: ${operation}`);
    if (operation === 'create' ? old : !old || old.metadata.kind === 'stakeholder') throw new Error(`Invalid existing definition for ${operation}: ${id}`);
    if (!document?.metadata || document.metadata.id !== id || typeof reason !== 'string' || !reason.trim()) throw new Error(`Domain change needs a matching definition and reason: ${id}`);
    const path = domainDocumentPath(document.metadata);
    const after = formatDomainDocument(document);
    if (operation === 'create' && document.metadata.status !== 'accepted-target') throw new Error('New definitions must be accepted-target');
    if (old && old.path !== path) throw new Error(`Changing ownership requires retiring and replacing the old ID: ${id}`);
    if (old?.metadata.status === 'retired') throw new Error(`Retired IDs cannot be reused: ${id}`);
    if (['retire', 'relocate'].includes(operation) !== (document.metadata.status === 'retired')) throw new Error(`Invalid retirement status: ${id}`);
    if (operation === 'implement') {
      const { status: _old, implementation_refs: _oldRefs, ...before } = old.metadata;
      const { status: _new, implementation_refs: refs, ...after } = document.metadata;
      const { ticket, local_id: localId, tests } = change.evidence || {};
      if (old.metadata.status !== 'accepted-target' || document.metadata.status !== 'implemented' || !isDeepStrictEqual({ ...before }, { ...after }) || document.body !== old.body
          || !PLAN_ID.test(ticket || '') || proposal.links?.[localId] !== id || !Array.isArray(tests) || !tests.length
          || !tests.every((path) => typeof path === 'string' && /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test|\.spec)\./.test(path))) throw new Error(`Invalid implementation evidence for ${id}`);
      const ticketText = await readDomainFile(root, `docs/plans/${planSetId}/${ticket}.md`);
      if (!ticketText.includes(id) && !new RegExp(`\\b${localId}\\b`).test(ticketText)) throw new Error(`Ticket does not cover ${id}`);
      const completed = await implementedTickets({ root, session: join(root, '.io') });
      const sha = completed.get(ticket);
      if (!sha || !isDeepStrictEqual(refs, tests.map((path) => `${sha}:${path}`))) throw new Error(`No matching completed implementation for ${id}`);
      const changedPaths = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], { cwd: root, encoding: 'utf8' }).split('\0');
      if (tests.some((path) => !changedPaths.includes(path))) throw new Error(`Implementation commit does not contain the reported tests for ${id}`);
    } else if (document.metadata.status === 'implemented') throw new Error('Edited definitions require fresh implementation verification');
    if (operation === 'relocate' && !document.metadata.replaced_by?.some((replacement) => replacement.split('.')[0] !== document.metadata.owner_context && proposal.changes.some((item) => item.id === replacement && item.operation === 'create'))) {
      throw new Error(`Relocation needs a new replacement in another Context: ${id}`);
    }
    entries.set(id, { path, ...document, original: after });
    if (old?.original !== after) changes.push({ path, before: old?.original ?? null, after });
  }
  const activeNames = new Map();
  for (const { metadata } of entries.values()) {
    if (metadata.status === 'retired' || metadata.kind === 'stakeholder') continue;
    const key = JSON.stringify([metadata.owner_context ?? null, metadata.kind, metadata.name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')]);
    const previous = activeNames.get(key);
    if (previous && (touched.has(previous) || touched.has(metadata.id))) throw new Error(`Duplicate domain name: ${previous} and ${metadata.id}`);
    activeNames.set(key, metadata.id);
  }
  verifyLinks(requirements, proposal.links, entries);
  const documents = [...entries.values()];
  validateDomainGraph(documents.filter(({ metadata }) => metadata.kind !== 'stakeholder'), snapshot.contextIds,
    new Set(documents.filter(({ metadata }) => metadata.kind === 'stakeholder').map(({ metadata }) => metadata.id)));
  const before = await readOptional(root, linksPath);
  const after = json({ schema_version: 1, links: Object.fromEntries(Object.entries(proposal.links).sort(([a], [b]) => a.localeCompare(b, 'en'))) });
  if (after !== before) changes.push({ path: linksPath, before, after });
  changes.push(...await domainIndexChanges(root, { ...snapshot, documents }));
  return { schema_version: 1, plan_set_id: planSetId, domain_version: snapshot.version, requirements_sha256: digest(requirements), proposal, changes };
}

export async function assertDomainSyncCurrent(root, planSetId) {
  const source = await readOptional(root, specPath(planSetId, 'domain-links.json'));
  if (source === null) return;
  const { schema_version: version, links } = JSON.parse(source);
  if (version !== 1) throw new Error('Invalid domain links schema version');
  const snapshot = await loadDomainSnapshot(root);
  verifyLinks(await readDomainFile(root, specPath(planSetId, 'requirements.md')), links, new Map(snapshot.documents.map((entry) => [entry.metadata.id, entry])));
  const indexes = await domainIndexChanges(root, snapshot);
  if (indexes.length) throw new Error(`Domain index is out of date: ${indexes[0].path}`);
}

export async function applyDomainSync(root, plan, { commit } = {}) {
  const lock = sessionOutputPath(root, 'runtime/domain/sync.lock');
  await mkdir(lock);
  const changed = [];
  try {
    const fresh = await planDomainSync(root, plan.plan_set_id, plan.proposal);
    if (json(fresh) !== json(plan)) throw new Error('Domain sync plan is stale; create a new plan');
    for (const entry of fresh.changes) {
      if (await readOptional(root, entry.path) !== entry.before) throw new Error(`Domain sync path changed during apply: ${entry.path}`);
      if (entry.after === null) await removeDomainIndex(root, entry.path);
      else await writeDomainFile(root, entry.path, entry.after);
      changed.push(entry);
    }
    if (commit) await commit(changed.map(({ path }) => path));
    return changed.map(({ path }) => path);
  } catch (error) {
    for (const { path, before } of changed.reverse()) {
      if (before === null) await rm(join(root, path), { force: true });
      else await writeDomainFile(root, path, before);
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function readStageDomainSync(root, input) {
  if (!isDomainSyncStage(input.skill) || !input.context?.plan_set_id) return null;
  const path = domainSyncPath(input.execution_id);
  const source = await readOptional(root, `.io/${path}`);
  if (source === null) return null;
  const plan = JSON.parse(source);
  if (plan.plan_set_id !== input.context.plan_set_id) throw new Error('Domain sync belongs to another Plan Set');
  if (plan.proposal?.changes?.some(({ operation }) => operation === 'implement')) throw new Error('Implementation evidence cannot be promoted by a requirements/design stage');
  return plan;
}

export async function assertStageDomainSync(root, input) {
  if (!isDomainSyncStage(input.skill) || !input.context?.plan_set_id) return;
  const plan = await readStageDomainSync(root, input);
  if (plan) {
    const current = await planDomainSync(root, plan.plan_set_id, { schema_version: 1, changes: [], links: plan.proposal.links });
    if (current.requirements_sha256 !== plan.requirements_sha256 || current.changes.length) throw new Error('Domain sync has not been applied to current requirements');
    for (const { path, after } of plan.changes) {
      if (await readOptional(root, path) !== after) throw new Error(`Domain sync has not been applied: ${path}`);
    }
  }
  if (!plan && input.skill === 'bounded-context') {
    const requirements = await readOptional(root, specPath(input.context.plan_set_id, 'requirements.md'));
    if (requirements && /\| 이벤트 ID \|.*\| 공통 ID \|/.test(requirements)
        && await readOptional(root, specPath(input.context.plan_set_id, 'domain-links.json')) === null) {
      throw new Error('Fixed requirements with domain IDs require a domain sync plan');
    }
  }
  await assertDomainSyncCurrent(root, input.context.plan_set_id);
}
