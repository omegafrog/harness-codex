#!/usr/bin/env node
import { isAbsolute } from 'node:path';
const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput } = await import(new URL('skill-execution.mjs', installed));
const { createComposerWorkspace, prepareComposerWorkspace } = await import(new URL('composer-workspace.mjs', installed));
const { findExecutionInput } = await import(new URL('execution-input.mjs', installed));
const { cliSession } = await import(new URL('cli-session.mjs', installed));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'plan-set-id', 'request'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute root and execution-id are required');
  if (opts.request !== undefined) {
    const record = await createComposerWorkspace({ root: opts.root, plan_set_id: opts['plan-set-id'], request: opts.request, execution_id: opts['execution-id'] });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    process.exit(0);
  }
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  if (input.skill !== 'workflow-compose') throw new Error('Expected workflow-compose input');
  await validateSkillInput({ root: opts.root, input });
  const location = await findExecutionInput(opts.root, opts['execution-id']);
  if (location.workspace !== opts.root) throw new Error('Compose input is outside workspace');
  const record = await prepareComposerWorkspace({ root: opts.root, session, input, inputPath: location.path });
  process.stdout.write(`${JSON.stringify(record)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
