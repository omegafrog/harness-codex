#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { isAbsolute } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/skill-execution.mjs', import.meta.url);
const moduleUrl = existsSync(installed) && !sourceCheckout ? installed : new URL('../../src/workflow/skill-execution.mjs', import.meta.url);
const { resolveSkillBinding, resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillReturn, assessContextBudget } = await import(moduleUrl.href);
try {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  const allowed = action === 'binding' ? ['root', 'skill', 'workflow', 'stage'] : action === 'validate-return' ? ['root', 'session-directory', 'execution-id', 'return'] : action === 'budget' ? ['root', 'estimate', 'used'] : [];
  if (!allowed.length) throw new Error('Expected binding, budget or validate-return');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key) || !args[i + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${args[i]}`);
    options[key] = args[i + 1];
  }
  if (!isAbsolute(options.root || '')) throw new Error('Absolute --root is required');
  let result;
  if (action === 'binding') result = await resolveSkillBinding(options);
  else if (action === 'budget') result = await assessContextBudget({ root: options.root, estimatedTokens: options.estimate?.trim() ? Number(options.estimate) : NaN, usedTokens: options.used === undefined ? null : options.used.trim() ? Number(options.used) : NaN });
  else {
    const session = await resolveSkillSession(options.root, options['session-directory']);
    const read = (path) => readSkillSessionJson({ root: options.root, session_directory: session, path });
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options['execution-id'] || '')) throw new Error('Valid execution-id is required');
    const input = await readExecutionInput({ root: options.root, execution_id: options['execution-id'] });
    if (input.execution_id !== options['execution-id']) throw new Error('Input execution ID mismatch');
    if (input.session_directory !== session) throw new Error('Input session directory does not match caller session');
    result = await validateSkillReturn({ root: options.root, input, envelope: await read(options.return) });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
