#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
const installed = new URL('../harness-runtime/src/workflow/worktrees.mjs', import.meta.url);
const { recordWorkflowSession } = await import(existsSync(installed) && !sourceCheckout ? installed.href : new URL('../../src/workflow/worktrees.mjs', import.meta.url).href);
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['workspace-root', 'repository-root', 'key', 'session-id', 'execution-id'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts['workspace-root'] || '') || !isAbsolute(opts['repository-root'] || '') || !opts.key || !opts['session-id'] || !opts['execution-id']) throw new Error('Absolute roots, key, session ID and execution ID are required');
  const result = await recordWorkflowSession({ workspace_root: opts['workspace-root'], repository_root: opts['repository-root'], key: opts.key, session_id: opts['session-id'], execution_id: opts['execution-id'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
