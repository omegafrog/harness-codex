import { performance } from 'node:perf_hooks';
import { buildSearchIndex, discoverDomain, loadDomainSnapshot } from './search.mjs';

export async function benchmarkDomainSearch(root, cases) {
  if (!Array.isArray(cases) || !cases.length || cases.some(({ query, expected }) => typeof query !== 'string' || !query.trim()
    || !Array.isArray(expected) || !expected.length || !expected.every((id) => typeof id === 'string'))) throw new Error('Benchmark requires query and expected ID cases');
  const start = performance.now();
  const snapshot = await loadDomainSnapshot(root);
  const index = buildSearchIndex(snapshot);
  const preparationMs = performance.now() - start;
  const rows = cases.map(({ query, expected }) => {
    const started = performance.now();
    const { candidates } = discoverDomain(snapshot, query, { index, limit: 5 });
    const latency = performance.now() - started;
    const candidatesIds = candidates.map(({ id }) => id);
    const uniqueExpected = new Set(expected);
    return { query, expected: [...uniqueExpected], candidates: candidatesIds,
      recall_at_5: candidatesIds.filter((id) => uniqueExpected.has(id)).length / uniqueExpected.size,
      search_ms: latency, discover_calls: 1, batch_get_calls: candidatesIds.length ? 1 : 0 };
  });
  return { version: snapshot.version, preparation_ms: preparationMs,
    recall_at_5: rows.reduce((total, row) => total + row.recall_at_5, 0) / rows.length, cases: rows };
}
