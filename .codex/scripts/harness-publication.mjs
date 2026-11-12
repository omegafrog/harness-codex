#!/usr/bin/env node
import { resolve } from 'node:path';
const { updatePublication } = await import('../../.harness/src/tracker/publication.mjs');
const { resolveCommandContext, latestReviewResult, reviewFixedPoint } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);

try {
  const [action, ...args] = process.argv.slice(2);
  const options = { action };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--root': 'root', '--plan-set': 'planSetId', '--plan': 'planId', '--item': 'itemId' }[args[i]];
    if (!key || !args[i + 1] || Object.hasOwn(options, key) && key !== 'root') throw new Error('Invalid publication argument');
    options[key] = args[i + 1];
  }
  { const ctx = resolveCommandContext({ root: options.root, planSetId: options.planSetId }); options.root = ctx.root; options.planSetId = ctx.plan_set_id ?? undefined; }
  process.stdout.write(`${JSON.stringify(await updatePublication(options))}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
