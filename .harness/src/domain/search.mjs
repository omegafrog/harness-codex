import { createHash } from 'node:crypto';
import { readRegistry } from '../stakeholders/cards.mjs';
import { parseDomainContexts, readDomainFile, readDomainRepository } from './repository.mjs';
import { validateDomainGraph } from './validation.mjs';

const optional = (read) => read.catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const normalize = (value) => value.normalize('NFKC').toLowerCase().trim();
function tokens(value) {
  const words = normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
  return words.flatMap((word) => /\p{Script=Hangul}/u.test(word)
    ? [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))]
    : [word]);
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const linksOf = (m) => [...new Set(['references', 'actors', 'rules', 'trigger_events', 'events', 'replaced_by'].flatMap((field) => m[field] || []))];
const brief = (entry) => ({
  id: entry.metadata.id, kind: entry.metadata.kind, name: entry.metadata.name, status: entry.metadata.status,
  owner_context: entry.metadata.owner_context ?? null, contexts: entry.metadata.contexts ?? [], path: entry.path,
  summary: (entry.metadata.statement || entry.metadata.fact || entry.metadata.purpose || entry.body).replace(/\s+/g, ' ').trim().slice(0, 180),
  related: linksOf(entry.metadata), source_refs: entry.metadata.source_refs, version: entry.version,
});

export async function loadDomainSnapshot(root) {
  const documents = await readDomainRepository(root);
  const [glossary, contextMap] = await Promise.all(['CONTEXT.md', 'CONTEXT-MAP.md'].map((path) => optional(readDomainFile(root, path))));
  const contexts = parseDomainContexts(contextMap);
  const contextIds = new Set(contexts.keys());
  const { cards, problems } = await readRegistry(root);
  if (problems.length) throw new Error(`${problems[0].path}: ${problems[0].message}`);
  validateDomainGraph(documents, contextIds, new Set(cards.map(({ card }) => card.id)));
  for (const { path, card, notes } of cards) {
    documents.push({ path, metadata: { id: card.id, kind: 'stakeholder', name: card.role, status: 'accepted-target', aliases: card.vocabulary, source_refs: [path], references: [] }, body: [card.authority, ...card.goals, notes].join('\n'), original: await readDomainFile(root, path), card });
  }
  for (const entry of documents) entry.version = hash(entry);
  return { documents, contextIds, contexts, glossary, contextMap, version: hash([1, glossary, contextMap, documents.map(({ path, version }) => [path, version])]) };
}

export function buildSearchIndex(snapshot) {
  const terms = Object.create(null);
  const termsByName = new Map();
  for (const row of glossaryTerms(snapshot.glossary)) for (const name of row.names) termsByName.set(normalize(name), row.names);
  const names = [];
  const lengths = snapshot.documents.map(({ metadata, body }, i) => {
    const original = [metadata.name, ...metadata.aliases];
    const entryNames = [...new Set(original.flatMap((name) => [name, ...(termsByName.get(normalize(name)) || [])]))];
    names.push(entryNames);
    const words = tokens([...entryNames, ...Object.values(metadata).filter((value) => typeof value === 'string'), body].join(' '));
    for (const word of words) {
      const postings = terms[word] ??= {};
      postings[i] = (postings[i] || 0) + 1;
    }
    return words.length;
  });
  return { version: snapshot.version, lengths, terms, names };
}

export function searchDomain(snapshot, query, { context, subdomain, kind, status = 'current', limit = 5, index = buildSearchIndex(snapshot) } = {}) {
  const queryTerms = [...new Set(tokens(query))];
  const phrase = normalize(query);
  const { documents } = snapshot;
  const average = index.lengths.reduce((total, n) => total + n, 0) / documents.length || 1;
  const subdomainContexts = new Set(documents.find(({ metadata }) => metadata.id === subdomain && metadata.kind === 'subdomain')?.metadata.contexts || []);
  return documents.flatMap((entry, i) => {
    const m = entry.metadata;
    if ((context && m.owner_context !== context && !m.contexts?.includes(context)) || (subdomain && m.id !== subdomain && !subdomainContexts.has(m.owner_context)) || (kind && m.kind !== kind)) return [];
    if (status === 'current' ? m.status === 'retired' : status !== 'all' && m.status !== status) return [];
    const evidence = [], exactId = phrase === normalize(m.id);
    const exactName = !!phrase && index.names[i].some((name) => normalize(name) === phrase);
    if (exactId) evidence.push('id');
    if (exactName) evidence.push('name_or_alias');
    let score = 0;
    for (const term of queryTerms) {
      const postings = index.terms[term];
      const frequency = postings?.[i];
      if (!frequency) continue;
      const count = Object.keys(postings).length;
      score += Math.log(1 + (documents.length - count + 0.5) / (count + 0.5))
        * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * index.lengths[i] / average));
    }
    if (score) evidence.push('bm25');
    if (!evidence.length && phrase) return [];
    return [{ ...brief(entry), score: Number(score.toFixed(6)), evidence }];
  }).sort((a, b) => Number(b.evidence.includes('id')) - Number(a.evidence.includes('id'))
    || Number(b.evidence.includes('name_or_alias')) - Number(a.evidence.includes('name_or_alias'))
    || b.score - a.score || a.id.localeCompare(b.id, 'en')).slice(0, limit);
}

export function discoverDomain(snapshot, query, options = {}) {
  let candidates = searchDomain(snapshot, query, options);
  const expanded = !candidates.length && Boolean(options.context || options.subdomain);
  if (expanded) candidates = searchDomain(snapshot, query, { ...options, context: undefined, subdomain: undefined });
  const owners = new Set(candidates.flatMap(({ owner_context, contexts }) => [owner_context, ...contexts].filter(Boolean)));
  if (!options.context || expanded) {
    const phrase = normalize(query);
    for (const [id, { name, responsibility }] of snapshot.contexts) {
      if (owners.size >= (options.limit ?? 5)) break;
      if ([id, name].some((term) => term && phrase.includes(normalize(term))) || responsibility && phrase === normalize(responsibility)) owners.add(id);
    }
  }
  const selected = new Set(candidates.map(({ id }) => id));
  const related = snapshot.documents.filter(({ metadata }) => metadata.status !== 'retired' && !selected.has(metadata.id)
    && (candidates.some(({ related }) => related.includes(metadata.id)) || linksOf(metadata).some((id) => selected.has(id))))
    .slice(0, options.limit ?? 5).map(brief);
  return { version: snapshot.version, candidates, expanded, contexts: [...owners].sort(),
    subdomains: snapshot.documents.filter(({ metadata }) => metadata.kind === 'subdomain' && metadata.status !== 'retired' && metadata.contexts.some((id) => owners.has(id))).slice(0, options.limit ?? 5).map(brief), related };
}

export function glossaryTerms(glossary) {
  const result = [];
  let header = [];
  for (const line of glossary.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { header = []; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.includes('Canonical Term') && cells.includes('Aliases')) { header = cells; continue; }
    if (!header.length || cells.length !== header.length || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const canonical = cells[header.indexOf('Canonical Term')];
    const aliases = cells[header.indexOf('Aliases')];
    const names = [canonical, cells[header.indexOf('Korean')], cells[header.indexOf('English')], ...(aliases || '').split(/[,;]/).map((name) => name.trim())].filter((name) => name && name !== '-');
    result.push({ canonical, aliases, names, source: 'CONTEXT.md' });
  }
  return result;
}
