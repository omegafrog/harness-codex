#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
const installed = new URL('../harness-runtime/src/workflow/', import.meta.url);
const base = existsSync(new URL('skill-execution.mjs', installed)) && !sourceCheckout ? installed : new URL('../../src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillReturn } = await import(new URL('skill-execution.mjs', base));
const { identifyQuestions } = await import(new URL('questions.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'return'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !opts.return) throw new Error('Absolute root, execution-id and return are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Valid execution-id is required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  if (input.session_directory !== session) throw new Error('Input session directory does not match caller session');
  const envelope = await readSkillSessionJson({ root: opts.root, session_directory: session, path: opts.return });
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('Structured result is required');
  const prefix = `runtime/executions/${input.execution_id}`;
  if (opts.return !== `${prefix}/return.json`) throw new Error('Return must belong to the requested execution');
  if (envelope.result.questions?.length) {
    if (envelope.code !== 'REVIEW_REQUIRED') throw new Error('Questions require REVIEW_REQUIRED');
    envelope.result.questions = identifyQuestions(input.execution_id, envelope.result.questions.map(({ question_id, ...question }) => question));
  }
  if (envelope.result_ref === null && !(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED')) envelope.result_ref = `${prefix}/result.json`;
  await validateSkillReturn({ root: opts.root, input, envelope });
  if (envelope.result_ref) {
    const path = join(session, envelope.result_ref);
    try {
      if (!isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), envelope.result)) throw new Error('Worker result file differs from its session response');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(path, JSON.stringify(envelope.result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
  }
  await writeFile(join(session, opts.return), JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
