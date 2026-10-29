#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
const installed = new URL('../harness-runtime/src/workflow/codex-process.mjs', import.meta.url);
const base = existsSync(installed) && !sourceCheckout ? new URL('../harness-runtime/src/workflow/', import.meta.url) : new URL('../../src/workflow/', import.meta.url);
const { runCodexProcess } = await import(new URL('codex-process.mjs', base));
const { resolveSkillBinding, readExecutionInput } = await import(new URL('skill-execution.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
try {
  const args = process.argv.slice(2), opts = {}, dirs = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'skill', 'workflow', 'stage', 'schema', 'output', 'prompt', 'worktree-ref', 'execution-id', 'resume', 'add-dir'].includes(k) || !args[i + 1] || (k !== 'add-dir' && Object.hasOwn(opts, k))) throw new Error(`Invalid argument: ${args[i]}`);
    if (k === 'add-dir') dirs.push(args[i + 1]); else opts[k] = args[i + 1];
  }
  if (!['root', 'schema', 'output', 'prompt'].every((key) => isAbsolute(opts[key] || '')) || !opts.skill || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '') || dirs.some((dir) => !isAbsolute(dir))) throw new Error('Absolute paths, skill and execution-id are required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id'] || input.skill !== opts.skill) throw new Error('Input does not match the requested execution');
  const binding = await resolveSkillBinding({ root: opts.root, skill: opts.skill, workflow: opts.workflow || null, stage: opts.stage || null });
  const command = ['exec', '--sandbox', 'workspace-write', ...dirs.flatMap((dir) => ['--add-dir', dir]), '--cd', opts.root, '--model', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--disable', 'multi_agent', '--json', '--output-schema', opts.schema, '--output-last-message', opts.output, ...(opts.resume ? ['resume', opts.resume, '-'] : ['-'])];
  const result = await runCodexProcess({ root: opts.root, args: command, prompt: await readFile(opts.prompt, 'utf8'), env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'] }, onStart: async (pid) => process.stderr.write(`${JSON.stringify({ event: 'started', pid })}\n`), onThread: async (threadId) => process.stderr.write(`${JSON.stringify({ event: 'thread.started', thread_id: threadId })}\n`) });
  if (opts.resume && result.threadId !== opts.resume) throw new Error('Resumed Codex session ID mismatch');
  process.stdout.write(`${JSON.stringify({ ...result, binding })}\n`);
  if (result.code !== 0) process.exitCode = 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
