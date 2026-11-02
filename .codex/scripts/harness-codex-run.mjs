#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

async function codexResumeWriteDirs(sessionId, env) {
  const home = resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));
  const sessionRoot = join(home, 'sessions');
  const dirs = new Set();
  async function findSession(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await findSession(path);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return dirname(path);
    }
    return null;
  }
  const sessionDir = await findSession(await realpath(sessionRoot));
  if (!sessionDir) throw new Error(`Codex resume session file not found under ${sessionRoot}: ${sessionId}`);
  dirs.add(await realpath(sessionDir));
  for (const path of ['thread-writer-locks', 'shell_snapshots', 'tmp/arg0', 'tmp/arg0-linux']) {
    try { dirs.add(await realpath(join(home, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...dirs];
}

const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const base = installed;
const { runCodexProcess } = await import(new URL('codex-process.mjs', base));
const { resolveSkillBinding, resolveAgentSandbox, readExecutionInput, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
const { findExecutionInput } = await import(new URL('execution-input.mjs', base));
const { writeOutputSchema } = await import(new URL('output-schema.mjs', base));
const { recordExecutionState, processIdentity } = await import(new URL('execution-state.mjs', base));
const { parseWorktreeRecord, recordWorkflowSession } = await import(new URL('worktrees.mjs', base));
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
  if (!existsSync(schema)) await writeOutputSchema({ root, input, prefix: `runtime/executions/${opts['execution-id']}`, path: schema });
  const schemaInfo = await lstat(schema);
  if (!schemaInfo.isFile() || schemaInfo.isSymbolicLink()) throw new Error('Output schema must be a regular file');
  const outputSchema = JSON.parse(await readFile(schema, 'utf8'));
  if (outputSchema.properties?.execution_id?.const !== opts['execution-id'] || outputSchema.properties?.skill?.const !== input.skill) throw new Error('Output schema does not match the execution input');
  const internal = `.codex/internal-skills/${input.skill}/GUIDE.md`;
  const publicSkill = `.agents/skills/${input.skill}/SKILL.md`;
  const guide = [internal, publicSkill, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
  if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
  const location = await findExecutionInput(root, opts['execution-id']);
  const answers = join(prefix, 'answers.json');
  const feedback = join(prefix, 'feedback.json');
  const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow: opts.workflow || null, stage: opts.stage || null });
  const executionBinding = { ...binding, sandbox };
  const prompt = `Read ${guide} and ${location.path}.${profile ? ` Read .codex/agents/${profile}.toml.` : ''}${existsSync(answers) ? ` Read the user's answers from ${answers}.` : ''}${existsSync(feedback) ? ` Read execution feedback from ${feedback} and correct the previous request.` : ''}${sandbox === 'read-only' ? ' This execution cannot write files. Return any newly produced report as result.artifact_contents with a filename, kind and full text; the caller will save it in the session. Include existing artifacts only as references.' : ''} Perform the assigned skill and return its result in the required schema. The caller validates the return and records execution state. Follow the user's stopping conditions in the input.`;
  const resume = input.context?.resume_session_id;
  const resumeWriteDirs = resume ? await codexResumeWriteDirs(resume, process.env) : [];
  const command = ['exec', '--sandbox', sandbox, ...resumeWriteDirs.flatMap((path) => ['--add-dir', path]), '--cd', root, '--model', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--enable', 'multi_agent', '--json', '--output-schema', schema, '--output-last-message', output, ...(resume ? ['resume', resume, '-'] : ['-'])];
  const owner = await processIdentity(process.pid);
  if (!owner?.start || !owner.boot) throw new Error('Runner process identity unavailable');
  await recordExecutionState({ root, input, binding, status: 'running', owner, runnerClaim: true });
  const record = parseWorktreeRecord(await readFile(opts['worktree-ref'], 'utf8'));
  const result = await runCodexProcess({ root, args: command, prompt, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'] }, onStart: async (pid) => {
    const child = await processIdentity(pid);
    if (!child?.start || !child.boot) throw new Error('Child process identity unavailable');
    await recordExecutionState({ root, input, binding, status: 'running', owner, child });
    process.stderr.write(`${JSON.stringify({ event: 'started', pid })}\n`);
  }, onThread: async (threadId) => {
    if (resume && threadId !== resume) throw new Error('Resumed Codex session ID mismatch');
    await recordWorkflowSession({ workspace_root: root, repository_root: record.return_root, key: input.context.stage_id, session_id: threadId, execution_id: input.execution_id });
    process.stderr.write(`${JSON.stringify({ event: 'thread.started', thread_id: threadId })}\n`);
  } });
  await writeFile(join(prefix, 'exec.stderr.json'), JSON.stringify({ exit_code: result.code, stderr: result.stderr, codex_errors: result.errors, thread_id: result.threadId, binding: executionBinding }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (resume && result.threadId !== resume) throw new Error('Resumed Codex session ID mismatch');
  process.stdout.write(`${JSON.stringify({ ...result, binding: executionBinding })}\n`);
  if (result.code !== 0) process.exitCode = 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
