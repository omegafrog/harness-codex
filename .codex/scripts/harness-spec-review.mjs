#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/spec-review.mjs', import.meta.url);
const source = new URL('../../src/workflow/spec-review.mjs', import.meta.url);
const { snapshotSpecReview, inspectSpecReviews } = await import(existsSync(installed) ? installed.href : source.href);
const outputModule = new URL('./session-output.mjs', existsSync(installed) ? installed : source);
const { sessionOutputPath } = await import(outputModule.href);
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() }, inputs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--ticket', '--axis', '--reviews', '--input'].includes(flag) || !value) throw new Error('Invalid review arguments');
    if (flag === '--input') inputs.push(value);
    else options[flag === '--ticket' ? 'ticketId' : flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  let result;
  if (action === 'snapshot') result = await snapshotSpecReview({ ...options, input_paths: inputs });
  else if (action === 'check') {
    const reviews = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
    result = await inspectSpecReviews({ ...options, reviews, ...(options.axis ? { axes: [options.axis] } : {}) });
    if (result.status !== 'pass') process.exitCode = 1;
  } else throw new Error('Usage: harness-spec-review.mjs snapshot|check --root DIR --ticket ID [--axis product|architecture] [--input RELATIVE] [--reviews SESSION-RELATIVE-JSON]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
