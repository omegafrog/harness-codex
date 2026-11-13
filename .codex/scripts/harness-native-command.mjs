#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { readExecutionInput, readSkillSessionJson, validateSkillInput } from '../../.harness/src/workflow/skill-execution.mjs';

try {
  const args = process.argv.slice(2), separator = args.indexOf('--'), opts = {};
  if (separator < 0 || !args[separator + 1]) throw new Error('A command after -- is required');
  for (let i = 0; i < separator; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'execution-id', 'agent-id'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid native command arguments');
    opts[key] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '') || !opts['agent-id']) throw new Error('Native root, execution ID and agent ID are required');
  const root = resolveCommandContext({ root: opts.root }).root;
  const input = await readExecutionInput({ root, execution_id: opts['execution-id'] });
  await validateSkillInput({ root, input });
  const control = input.context?.control_session_directory || input.session_directory;
  const document = await readSkillSessionJson({ root, session_directory: control, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' });
  const stage = (document.state || document).stages?.[input.context?.stage_id || input.skill];
  if (stage?.status !== 'running' || !stage.native_managed || stage.execution_id !== input.execution_id || stage.native_agent_id !== opts['agent-id']) throw new Error('Native command does not match the bound running subagent');
  const env = { ...process.env, HARNESS_SESSION_DIR: input.session_directory, HARNESS_CONTROL_SESSION_DIR: control, HARNESS_SKILL_EXECUTION_ID: input.execution_id, HARNESS_WORKSPACE_ROOT: root, HARNESS_PROVIDER_ID: input.context?.provider || 'codex', HARNESS_REVIEW_EXECUTION_ID: input.execution_id, HARNESS_REVIEW_TICKET_ID: input.context?.plan_set_id || '' };
  const child = spawn(args[separator + 1], args.slice(separator + 2), { cwd: root, env, stdio: 'inherit' });
  child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = Number.isInteger(code) ? code : 1; if (signal) process.stderr.write(`Native command terminated by ${signal}\n`); });
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 2; }
