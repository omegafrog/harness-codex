#!/usr/bin/env node
import { dispatchSpecWriter } from '../../.harness/src/workflow/spec-writer.mjs';

try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['worktree-ref', 'execution-id', 'request', 'axis', 'provider'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid writer argument');
    opts[key] = args[i + 1];
  }
  if (!opts['worktree-ref'] || !opts['execution-id'] || !opts.request || !opts.axis || !opts.provider) throw new Error('Writer requires worktree-ref, execution-id, request, axis and provider');
  const result = await dispatchSpecWriter({ root: process.cwd(), worktreeRef: opts['worktree-ref'], executionId: opts['execution-id'], requestPath: opts.request, expectedAxis: opts.axis, expectedProvider: opts.provider });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
