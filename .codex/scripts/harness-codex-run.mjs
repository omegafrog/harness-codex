#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
const installed = new URL('../harness-runtime/src/workflow/', import.meta.url);
const base = existsSync(new URL('codex-process.mjs', installed)) && !sourceCheckout ? installed : new URL('../../src/workflow/', import.meta.url);
const { runCodexProcess } = await import(new URL('codex-process.mjs', base));
const { resolveSkillBinding, readExecutionInput, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
const { findExecutionInput } = await import(new URL('execution-input.mjs', base));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['worktree-ref', 'execution-id', 'workflow', 'stage'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts['worktree-ref'] || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute worktree-ref and execution-id are required');
  const root = process.cwd();
  const session = await cliSession(root, opts['worktree-ref']);
  const input = await readExecutionInput({ root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id'] || input.context?.worktree_ref !== opts['worktree-ref']) throw new Error('Input does not match the requested execution');
  if (input.context?.parent_execution_id) throw new Error('Internal tasks must run as subagents of their parent stage');
  if (input.skill === 'workflow-compose') throw new Error('Workflow composition is performed by harness-compose-workspace.mjs');
  await validateSkillInput({ root, input });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow: opts.workflow || null, stage: opts.stage || null });
  const prefix = join(session, 'runtime/executions', opts['execution-id']);
  const schema = join(prefix, 'return.schema.json'), output = join(prefix, 'return.json');
  const internal = `.codex/internal-skills/${input.skill}/GUIDE.md`;
  const publicSkill = `.agents/skills/${input.skill}/SKILL.md`;
  const guide = [internal, publicSkill, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
  if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
  const location = await findExecutionInput(root, opts['execution-id']);
  const answers = join(prefix, 'answers.json');
  const feedback = join(prefix, 'feedback.json');
  const profile = input.context?.agent_profile || input.context?.role;
  let sandbox = 'workspace-write';
  if (profile) {
    const config = await readFile(join(root, '.codex/agents', `${profile}.toml`), 'utf8');
    const mode = /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(config)?.[1];
    if (!['read-only', 'workspace-write'].includes(mode)) throw new Error('Agent profile requires a supported sandbox_mode');
    sandbox = mode;
  }
  const executionBinding = { ...binding, sandbox };
  const prompt = `Read ${guide} and ${location.path}.${profile ? ` Read .codex/agents/${profile}.toml.` : ''}${existsSync(answers) ? ` Read the user's answers from ${answers}.` : ''}${existsSync(feedback) ? ` Read execution feedback from ${feedback} and correct the previous request.` : ''}${sandbox === 'read-only' ? ' This execution cannot write files. Return any newly produced report as result.artifact_contents with a filename, kind and full text; the caller will save it in the session. Include existing artifacts only as references.' : ''} Perform the assigned skill and return its result in the required schema. The caller validates the return and records execution state. Follow the user's stopping conditions in the input.`;
  const resume = input.context?.resume_session_id;
  const command = ['exec', '--sandbox', sandbox, ...(sandbox !== 'read-only' && input.shared_guidance_root !== root ? ['--add-dir', input.shared_guidance_root] : []), '--cd', root, '--model', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--enable', 'multi_agent', '--json', '--output-schema', schema, '--output-last-message', output, ...(resume ? ['resume', resume, '-'] : ['-'])];
  const result = await runCodexProcess({ root, args: command, prompt, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'] }, onStart: async (pid) => process.stderr.write(`${JSON.stringify({ event: 'started', pid })}\n`), onThread: async (threadId) => process.stderr.write(`${JSON.stringify({ event: 'thread.started', thread_id: threadId })}\n`) });
  await writeFile(join(prefix, 'exec.stderr.json'), JSON.stringify({ exit_code: result.code, stderr: result.stderr, codex_errors: result.errors, thread_id: result.threadId, binding: executionBinding }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (resume && result.threadId !== resume) throw new Error('Resumed Codex session ID mismatch');
  process.stdout.write(`${JSON.stringify({ ...result, binding: executionBinding })}\n`);
  if (result.code !== 0) process.exitCode = 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
