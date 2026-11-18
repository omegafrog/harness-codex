import { readDomainFile, writeDomainFile, listDomainIndexPaths, removeDomainIndex } from './repository.mjs';

const line = ({ metadata, path }) => `- [${metadata.id}](${path.replace('docs/domain/', '')}) · ${metadata.name.replace(/\s+/g, ' ')} · ${metadata.status}`;
const header = '<!-- harness-domain index: generated -->';

export function renderDomainIndexes(snapshot) {
  const indexes = new Map();
  const documents = [...snapshot.documents].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const originals = documents.filter(({ metadata }) => metadata.kind !== 'stakeholder');
  if (documents.length) {
    const contexts = [...snapshot.contextIds].sort().filter((id) => originals.some(({ metadata }) => metadata.owner_context === id));
    indexes.set('docs/domain/INDEX.md', [header, '# 공통 도메인', ...contexts.map((id) => `- [${snapshot.contexts.get(id).name}](contexts/${id}/INDEX.md) · ${id} · ${snapshot.contexts.get(id).responsibility}`), ...documents.filter(({ metadata }) => !metadata.owner_context).map(line), ''].join('\n'));
    for (const id of contexts) {
      const path = `docs/domain/contexts/${id}/INDEX.md`;
      indexes.set(path, [header, `# ${id}`, ...originals.filter(({ metadata }) => metadata.owner_context === id).map((entry) => line(entry).replace(`(contexts/${id}/`, '(')), ''].join('\n'));
    }
  }
  return indexes;
}

export async function domainIndexChanges(root, snapshot) {
  const indexes = renderDomainIndexes(snapshot);
  const changes = [];
  for (const path of new Set([...indexes.keys(), ...await listDomainIndexPaths(root)])) {
    const expected = indexes.get(path) ?? null;
    const existing = await readDomainFile(root, path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing === expected) continue;
    if (expected === null && !existing.startsWith(header)) continue;
    if (existing !== null && !existing.startsWith(header)) throw new Error(`Refusing to overwrite a manually maintained index: ${path}`);
    changes.push({ path, before: existing, after: expected });
  }
  return changes;
}

export async function updateDomainIndexes(root, snapshot, { check = false } = {}) {
  const changes = await domainIndexChanges(root, snapshot);
  if (check && changes.length) throw new Error(`Domain index is out of date: ${changes[0].path}`);
  for (const { path, after } of changes) {
    if (after === null) await removeDomainIndex(root, path);
    else await writeDomainFile(root, path, after);
  }
  return [...renderDomainIndexes(snapshot).keys()];
}
