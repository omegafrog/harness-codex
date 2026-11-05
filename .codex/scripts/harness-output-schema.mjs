#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
const runtime = new URL('../../.harness/src/workflow/', import.meta.url);
const { readSkillSessionJson, readExecutionInput, resolveSkillSession, validateSkillInput } = await import(new URL('skill-execution.mjs', runtime));
const { writeOutputSchema } = await import(new URL('output-schema.mjs', runtime));
const { parseYaml } = await import(new URL('../eval/yaml.mjs', runtime));
const { configuredProvider } = await import(new URL('providers/index.mjs', runtime));
const { cliSession } = await import(new URL('cli-session.mjs', runtime));
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
  const config = parseYaml(await readFile(join(opts.root, '.codex/harness.yaml'), 'utf8'));
  await writeOutputSchema({ root: opts.root, input, prefix, path, provider: input.context?.workflow_binding?.provider || configuredProvider(config) });
  process.stdout.write(`${JSON.stringify({ path })}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
