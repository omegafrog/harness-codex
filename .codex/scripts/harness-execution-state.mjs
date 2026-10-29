#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { isAbsolute } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/', import.meta.url);
const source = new URL('../../src/workflow/', import.meta.url);
const base = existsSync(new URL('execution-state.mjs', installed)) && !sourceCheckout ? installed : source;
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput, resolveSkillBinding } = await import(new URL('skill-execution.mjs', base));
const { recordExecutionState, processIdentity } = await import(new URL('execution-state.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'status', 'code', 'result-ref', 'reason', 'owner-pid', 'child-pid', 'workflow', 'stage'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !['running', 'completed', 'action_required', 'blocked', 'failed', 'cancelled'].includes(opts.status)) throw new Error('Absolute root, execution-id and valid status are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Valid execution-id is required');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  await validateSkillInput({ root: opts.root, input });
  const binding = await resolveSkillBinding({ root: opts.root, skill: input.skill, workflow: opts.workflow || null, stage: opts.stage || null });
  const owner = opts['owner-pid'] ? await processIdentity(Number(opts['owner-pid'])) : null;
  const child = opts['child-pid'] ? await processIdentity(Number(opts['child-pid'])) : null;
  const result = await recordExecutionState({ root: opts.root, input, binding, status: opts.status, code: opts.code ?? null, result_ref: opts['result-ref'] ?? null, reason: opts.reason ?? null, owner, child });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
