#!/usr/bin/env node
import { benchmarkDomainSearch } from '../../.harness/src/domain/benchmark.mjs';
import { bootstrapDomainReport } from '../../.harness/src/domain/bootstrap.mjs';
import { checkDomainMerge } from '../../.harness/src/domain/merge-check.mjs';
import { parseArgs } from 'node:util';
import { applyDomainSync, planDomainSync } from '../../.harness/src/domain/sync.mjs';
import { readDomainFile } from '../../.harness/src/domain/repository.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { discoverDomain, loadDomainSnapshot, searchDomain } from '../../.harness/src/domain/search.mjs';
import { updateDomainIndexes } from '../../.harness/src/domain/index.mjs';
import { cachedDomainSearchIndex } from '../../.harness/src/domain/context-pack.mjs';
import { validateDomainRepository } from '../../.harness/src/domain/validation.mjs';

const usage = 'benchmark <dataset> | bootstrap | merge-check --base REF [--head REF] [--merged REF] [--review PATH] [--structural-only] | sync plan <plan-set-id> <proposal-path> | sync apply <plan-path> | Usage: harness-domain.mjs validate | index [--check] | get <id>... | discover|search <query> [--context ID] [--subdomain ID] [--kind KIND] [--status current|all|accepted-target|implemented|retired] [--limit N]';
try {
  const [command, ...args] = process.argv.slice(2);
  const { root } = resolveCommandContext();
  let result;
  if (command === 'benchmark' && args.length === 1) {
    result = await benchmarkDomainSearch(root, JSON.parse(await readDomainFile(root, args[0])));
  } else if (command === 'bootstrap' && !args.length) {
    result = await bootstrapDomainReport(root);
  } else if (command === 'merge-check') {
    const { values } = parseArgs({ args, options: { ...Object.fromEntries(['base', 'head', 'review', 'merged'].map((key) => [key, { type: 'string' }])), 'structural-only': { type: 'boolean' } } });
    if (!values.base) throw new Error(usage);
    result = await checkDomainMerge(root, { ...values, structuralOnly: values['structural-only'], reviewed: values.review ? JSON.parse(await readDomainFile(root, values.review)) : undefined });
    if (result.status !== 'PASS') process.exitCode = 1;
  } else if (command === 'sync' && args[0] === 'plan' && args.length === 3) {
    result = await planDomainSync(root, args[1], JSON.parse(await readDomainFile(root, args[2])));
  } else if (command === 'sync' && args[0] === 'apply' && args.length === 2) {
    result = { paths: await applyDomainSync(root, JSON.parse(await readDomainFile(root, args[1]))) };
  } else if (command === 'validate' && !args.length) {
    result = { valid: true, ...await validateDomainRepository(root) };
  } else if (command === 'index' && (!args.length || args.length === 1 && args[0] === '--check')) {
    const snapshot = await loadDomainSnapshot(root);
    result = { version: snapshot.version, paths: await updateDomainIndexes(root, snapshot, { check: args.length > 0 }) };
  } else if (command === 'get' && args.length && args.every((id) => !id.startsWith('-'))) {
    const snapshot = await loadDomainSnapshot(root);
    const definitions = [];
    for (const id of new Set(args)) {
      const entry = snapshot.documents.find(({ metadata }) => metadata.id === id);
      if (!entry) throw new Error(`Unknown domain ID: ${id}`);
      definitions.push(entry);
    }
    result = { version: snapshot.version, definitions };
  } else if (command === 'discover' || command === 'search') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['context', 'subdomain', 'kind', 'status', 'limit'].map((key) => [key, { type: 'string' }])) });
    const limit = Number(values.limit ?? 5);
    if (!positionals.length || !Number.isInteger(limit) || limit < 1 || limit > 50 || !['current', 'all', 'accepted-target', 'implemented', 'retired'].includes(values.status ?? 'current')) throw new Error(usage);
    const snapshot = await loadDomainSnapshot(root);
    const options = { ...values, limit, index: await cachedDomainSearchIndex(root, snapshot) };
    const query = positionals.join(' ');
    result = command === 'discover' ? discoverDomain(snapshot, query, options) : { version: snapshot.version, candidates: searchDomain(snapshot, query, options) };
  } else throw new Error(usage);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, error: error.message })}\n`);
  process.exitCode = 1;
}
