#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/execution.mjs', import.meta.url);
const source = new URL('../../src/workflow/execution.mjs', import.meta.url);
const { runExecution } = await import(existsSync(installed) ? installed.href : source.href);
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancellation.abort(new Error(`Interrupted: ${name}`)));
try {
  const options = { workspace_root: process.cwd(), signal: cancellation.signal };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--profile'].includes(flag) || !value) throw new Error('Usage: harness-exec.mjs --root DIR --profile ID');
    options[flag === '--root' ? 'workspace_root' : 'profile_id'] = flag === '--root' ? resolve(value) : value;
  }
  const result = await runExecution(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
