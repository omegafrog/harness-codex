#!/usr/bin/env node
import { resolve } from 'node:path';
const { updatePublication } = await import('../../.harness/src/tracker/publication.mjs');
try {
  const [action, ...args] = process.argv.slice(2);
  const options = { action, root: process.cwd() };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--root': 'root', '--plan-set': 'planSetId', '--plan': 'planId', '--item': 'itemId' }[args[i]];
    if (!key || !args[i + 1] || Object.hasOwn(options, key) && key !== 'root') throw new Error('Invalid publication argument');
    options[key] = args[i + 1];
  }
  options.root = resolve(options.root);
  process.stdout.write(`${JSON.stringify(await updatePublication(options))}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
