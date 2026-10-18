#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/tracker/lifecycle.mjs', import.meta.url);
const source = new URL('../../src/tracker/lifecycle.mjs', import.meta.url);
const { inspectTrackerSync, syncTrackerStatus } = await import(existsSync(installed) ? installed.href : source.href);
try {
  const [command, ...args] = process.argv.slice(2), options = { workspace_root: process.cwd() };
  const flags = { '--root': 'workspace_root', '--status': 'status', '--phase': 'phase', '--classification': 'classification' };
  const refs = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value) throw new Error(`Missing argument: ${key}`);
    if (key === '--ticket') refs.push(value);
    else if (flags[key]) options[flags[key]] = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  options.workspace_root = resolve(options.workspace_root);
  if (!['check', 'sync'].includes(command) || (command === 'sync' && refs.length !== 1)) throw new Error('Usage: harness-tracker.mjs check|sync --root DIR [--ticket REF] [--status planned|in-progress|blocked|completed] [--phase planning|implementation|test|review] [--classification backlog|committed]');
  if (command === 'check' && (options.status || options.phase || options.classification)) throw new Error('check is read-only');
  const result = await (command === 'check' ? inspectTrackerSync({ ...options, ticket_refs: refs.length ? refs : null }) : syncTrackerStatus({ ...options, ticket_ref: refs[0] }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
