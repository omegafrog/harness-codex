#!/usr/bin/env node
import { resolve } from 'node:path';
const installed = new URL('../../.harness/src/tracker/lifecycle.mjs', import.meta.url);
const { resolveCommandContext } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
const { commentTracker, inspectTrackerSync, readTrackerStatus, syncTrackerStatus } = await import(installed.href);
try {
  const [command, ...args] = process.argv.slice(2), options = {};
  const flags = { '--root': 'workspace_root', '--status': 'status', '--phase': 'phase', '--classification': 'classification', '--body': 'body' };
  const refs = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value) throw new Error(`Missing argument: ${key}`);
    if (key === '--ticket') refs.push(value);
    else if (flags[key]) options[flags[key]] = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  options.workspace_root = resolveCommandContext({ root: options.workspace_root }).root;
  if (!['check', 'read', 'sync', 'comment'].includes(command) || (command !== 'check' && refs.length !== 1)) throw new Error('Usage: harness-tracker.mjs check|read|sync|comment --root DIR [--ticket REF] [--status planned|in-progress|blocked|completed] [--phase planning|implementation|test|review] [--classification backlog|committed]');
  if (command === 'check' && (options.status || options.phase || options.classification)) throw new Error('check is read-only');
  if (command === 'read' && (options.status || options.phase || options.classification)) throw new Error('read is read-only');
  if (command !== 'comment' && options.body !== undefined) throw new Error('--body applies only to comment');
  const result = await (command === 'comment' ? commentTracker({ ...options, ticket_ref: refs[0] }) : command === 'check' ? inspectTrackerSync({ ...options, ticket_refs: refs.length ? refs : null }) : command === 'read' ? readTrackerStatus({ ...options, ticket_ref: refs[0] }) : syncTrackerStatus({ ...options, ticket_ref: refs[0] }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
