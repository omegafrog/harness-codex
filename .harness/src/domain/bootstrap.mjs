import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readDomainFile } from './repository.mjs';
import { buildSearchIndex, discoverDomain, loadDomainSnapshot } from './search.mjs';

export async function bootstrapDomainReport(root) {
  const snapshot = await loadDomainSnapshot(root);
  const index = buildSearchIndex(snapshot);
  const specs = await readdir(join(root, 'docs/specs'), { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const candidates = [];
  for (const spec of specs.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = `docs/specs/${spec.name}/requirements.md`;
    const source = await readDomainFile(root, path).catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (!/^- 상태: fixed\s*$/m.test(source)) continue;
    source.split(/\r?\n/).forEach((line, i) => {
      const ids = [...new Set(line.match(/\b(?:SD|BIZ|INV|EX|AC|EVT|POL|TRN)-\d+\b/g) || [])];
      const legacyEvent = /^\s*\|\s*\d+\s*\|/.test(line) && line.split('|').length === 9;
      if (!ids.length && !legacyEvent) return;
      candidates.push({ plan_set_id: spec.name, local_ids: ids, evidence: `${path}:${i + 1}`, text: line.trim(), needs_review: true,
        possible_existing_ids: discoverDomain(snapshot, line, { limit: 3, index }).candidates.map(({ id }) => id) });
    });
  }
  return {
    version: snapshot.version,
    contexts: [...snapshot.contextIds],
    references: ['CONTEXT.md', 'CONTEXT-MAP.md', 'docs/domain/stakeholders', 'docs/specs'],
    candidates,
  };
}
