#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { isAbsolute } from 'node:path';
const runtime = new URL('../harness-runtime/src/workflow/', import.meta.url);
const source = new URL('../../src/workflow/', import.meta.url);
const base = existsSync(new URL('output-schema.mjs', runtime)) && !sourceCheckout ? runtime : source;
const { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { writeOutputSchema } = await import(new URL('output-schema.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute root and execution-id are required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  await validateSkillInput({ root: opts.root, input });
  const prefix = `runtime/executions/${input.execution_id}`;
  const path = `${input.session_directory}/${prefix}/return.schema.json`;
  await writeOutputSchema({ root: opts.root, input, prefix, path });
  process.stdout.write(`${JSON.stringify({ path })}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
