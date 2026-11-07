#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const installed = new URL('../../.harness/src/wrapper/repair.mjs', import.meta.url);
const { reserveImplementationRepair } = await import(installed.href);
const { sessionOutputPath } = await import(new URL('../workflow/session-output.mjs', installed).href);
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan', '--reviews', '--reason', '--max-rounds'].includes(flag) || !value) throw new Error('Invalid code-review arguments');
    options[flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.plan || '')) throw new Error('Valid plan ID is required');
  let result;
  if (action === 'repair') {
    const evidence = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
    result = await reserveImplementationRepair({ root: options.root, planId: options.plan, reviewInput: evidence.review_input, reviews: evidence.reviews, scopeDecisions: evidence.scope_decisions ?? [], maxRounds: options['max-rounds'] === undefined ? 1 : Number(options['max-rounds']) });
  } else if (action === 'resolve') result = await reserveImplementationRepair({ root: options.root, planId: options.plan, resolution: options.reason });
  else throw new Error('Usage: harness-code-review.mjs repair|resolve --root DIR --plan ID [--reviews SESSION-RELATIVE-JSON] [--max-rounds N] [--reason USER-RESOLUTION]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass' && result.state !== 'passed') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
