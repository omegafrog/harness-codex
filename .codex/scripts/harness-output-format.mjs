#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { validateOutputFormat } from '../../.harness/src/workflow/output-schema.mjs';
import { cliSession } from '../../.harness/src/workflow/cli-session.mjs';
import { readExecutionInput, readSkillSessionJson, validateSkillInput } from '../../.harness/src/workflow/skill-execution.mjs';

try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid output format arguments');
    opts[key] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute root and execution-id are required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  await validateSkillInput({ root: opts.root, input });
  if (input.session_directory !== session) throw new Error('Execution session mismatch');
  const prefix = `runtime/executions/${input.execution_id}`;
  const schema = await readSkillSessionJson({ root: opts.root, session_directory: session, path: `${prefix}/return.schema.json` });
  let result;
  try {
    const value = await readSkillSessionJson({ root: opts.root, session_directory: session, path: `${prefix}/codex-last-message.json` });
    result = validateOutputFormat(value, schema);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    result = { valid: false, errors: [{ path: '$', rule: 'json', expected: 'valid JSON', value: null, message: error.message }] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 2; }
