import { createHash } from 'node:crypto';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { readDomainFile, writeDomainFile } from './repository.mjs';
import { buildSearchIndex, discoverDomain, loadDomainSnapshot, searchDomain, glossaryTerms } from './search.mjs';

const STAGE_KINDS = {
  'stakeholder-analysis': ['stakeholder', 'actor', 'rule'],
  'subdomain-candidates': ['subdomain', 'biz'],
  'ubiquitous-language': [],
  'event-storming': ['event', 'policy', 'transition', 'rule'],
  'subdomain-classification': ['subdomain'],
  'bounded-context': ['subdomain', 'biz', 'rule', 'event', 'policy'],
  'requirements-fix': ['actor', 'biz', 'rule', 'exception', 'event', 'policy', 'transition'],
  'domain-model': ['actor', 'biz', 'rule', 'exception', 'event'],
  'aggregate-design': ['biz', 'rule', 'exception', 'transition'],
  'domain-service': ['rule', 'policy', 'event'],
  'application-service': ['actor', 'biz', 'policy', 'rule'],
  'integration-design': ['event', 'policy'],
  'context-boundary': ['subdomain', 'biz', 'rule', 'event', 'policy'],
  'tactical-technology': ['rule', 'policy'],
  'tactical-ui': ['actor', 'biz', 'exception'],
  'tactical-api': ['actor', 'biz', 'rule', 'exception'],
  'tactical-data': ['rule', 'event', 'transition'],
};

export async function cachedDomainSearchIndex(root, snapshot) {
  if (!snapshot.documents.length) return buildSearchIndex(snapshot);
  const path = `runtime/domain/search-${snapshot.version}.json`;
  sessionOutputPath(root, path);
  try {
    const index = JSON.parse(await readDomainFile(root, `.io/${path}`));
    if (index.version === snapshot.version && Array.isArray(index.lengths) && index.lengths.length === snapshot.documents.length && Array.isArray(index.names) && index.terms && typeof index.terms === 'object') return index;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const index = buildSearchIndex(snapshot);
  await writeDomainFile(root, `.io/${path}`, JSON.stringify(index));
  return index;
}

export async function prepareDomainContextPack({ root, stage, request, feedback, answers }) {
  if (!Object.hasOwn(STAGE_KINDS, stage)) return null;
  const snapshot = await loadDomainSnapshot(root);
  if (!snapshot.documents.length) return null;
  const query = [request, feedback, ...(answers || []).map(({ answer }) => String(answer ?? ''))].filter(Boolean).join('\n');
  const key = createHash('sha256').update(JSON.stringify([1, stage, query, snapshot.version])).digest('hex');
  const path = `runtime/domain/pack-${key}.json`;
  sessionOutputPath(root, path);
  try {
    const existing = JSON.parse(await readDomainFile(root, `.io/${path}`));
    if (existing.key === key && existing.version === snapshot.version) return { base: 'session', path, kind: 'domain_context_pack' };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const index = await cachedDomainSearchIndex(root, snapshot);
  const discovery = discoverDomain(snapshot, query, { index });
  const selected = STAGE_KINDS[stage].flatMap((kind) => searchDomain(snapshot, query, { index, kind, limit: 3 }));
  const pack = {
    key, version: snapshot.version, stage,
    contexts: discovery.contexts,
    subdomains: discovery.subdomains.map(({ id }) => id),
    candidates: selected,
    ...(stage === 'ubiquitous-language' ? { terms: domainTerms(snapshot.glossary, query) } : {}),
    needs_expanded_search: !selected.length,
  };
  await writeDomainFile(root, `.io/${path}`, JSON.stringify(pack, null, 2) + '\n');
  return { base: 'session', path, kind: 'domain_context_pack' };
}

function domainTerms(glossary, query) {
  const text = query.normalize('NFKC').toLowerCase();
  return glossaryTerms(glossary).filter(({ names }) => names.some((name) => text.includes(name.normalize('NFKC').toLowerCase()))).slice(0, 10);
}
