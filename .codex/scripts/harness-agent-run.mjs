#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const base = installed;
const { loadProvider } = await import(new URL('providers/index.mjs', base));
const { resolveSkillBinding, resolveWorkflowStage, resolveAgentSandbox, readExecutionInput, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
const { executionInputAbsolutePath } = await import(new URL('execution-input.mjs', base));
const { inspectWorkspace } = await import(new URL('../eval/workspace-preflight.mjs', base));
const { writeOutputSchema } = await import(new URL('output-schema.mjs', base));
const { recordExecutionState, processIdentity } = await import(new URL('execution-state.mjs', base));
const { parseWorktreeRecord, recordWorkflowSession } = await import(new URL('worktrees.mjs', base));
const { assertWorkspaceTarget } = await import(new URL('../eval/case-workspace.mjs', base));
let recordEvent = () => {};
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['worktree-ref', 'execution-id', 'workflow', 'stage', 'background'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts['worktree-ref'] || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute worktree-ref and execution-id are required');
  if (opts.background && opts.background !== 'true') throw new Error('background must be true');
  const root = process.cwd();
  // 실행 입력과 worktree 참조가 서로 일치하는지 확인한 뒤 skill/profile을 선택한다.
  const session = await cliSession(root, opts['worktree-ref']);
  const workspace = await inspectWorkspace({ workspaceRoot: root, cwd: root });
  if (!workspace.valid) throw new Error(`Execution workspace invalid: ${workspace.reason}; cwd=${workspace.cwd}; git_root=${workspace.git_root}; registered=${workspace.worktree_registered}`);
  const input = await readExecutionInput({ root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id'] || input.context?.worktree_ref !== opts['worktree-ref']) throw new Error('Input does not match the requested execution');
  if (input.context?.parent_execution_id) throw new Error('Internal tasks must run as subagents of their parent stage');
  if (input.skill === 'workflow-compose') throw new Error('Workflow composition is performed by harness-compose-workspace.mjs');
  await validateSkillInput({ root, input });
  const { workflow, stage } = await resolveWorkflowStage({ root, input, workflow: opts.workflow || null, stage: opts.stage || null });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage });
  const providerId = input.context?.provider || binding.provider;
  if (providerId !== binding.provider || (input.context?.orchestrator_provider && input.context.orchestrator_provider !== providerId) || (input.context?.resume_provider && input.context.resume_provider !== providerId)) throw new Error('Execution provider must match the orchestrator, configured model binding, and resumed session');
  const adapter = await loadProvider(providerId);
  const prefix = join(session, 'runtime/executions', opts['execution-id']);
  const schema = join(prefix, 'return.schema.json'), output = join(prefix, 'codex-last-message.json');
  if (!existsSync(schema)) await writeOutputSchema({ root, input, prefix: `runtime/executions/${opts['execution-id']}`, path: schema, provider: providerId });
  const schemaInfo = await lstat(schema);
  if (!schemaInfo.isFile() || schemaInfo.isSymbolicLink()) throw new Error('Output schema must be a regular file');
  const outputSchema = JSON.parse(await readFile(schema, 'utf8'));
  if (outputSchema.properties?.execution_id?.const !== opts['execution-id'] || outputSchema.properties?.skill?.const !== input.skill) throw new Error('Output schema does not match the execution input');
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/codex-last-message.json`);
  if (opts.background === 'true') {
    await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/runner.stdout.log`);
    await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/runner.stderr.log`);
    const out = openSync(join(prefix, 'runner.stdout.log'), 'wx', 0o600);
    let err;
    try {
      err = openSync(join(prefix, 'runner.stderr.log'), 'wx', 0o600);
      const workerArgs = args.filter((value, index) => value !== '--background' && args[index - 1] !== '--background');
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), ...workerArgs], { cwd: root, env: { ...process.env, HARNESS_RUNNER_BACKGROUND: '1', HARNESS_RUNNER_LAUNCHER_PID: String(process.pid), HARNESS_RUNNER_CALLER_PID: String(process.ppid) }, detached: true, stdio: ['ignore', out, err] });
      await once(worker, 'spawn');
      worker.unref();
      process.stdout.write(`${JSON.stringify({ status: 'started', execution_id: input.execution_id, runner_pid: worker.pid, log_directory: prefix })}\n`);
    } finally { closeSync(out); if (err !== undefined) closeSync(err); }
    process.exit(0);
  }
  const internal = `.codex/internal-skills/${input.skill}/GUIDE.md`;
  const publicSkill = `.agents/skills/${input.skill}/SKILL.md`;
  const guide = [internal, publicSkill, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
  if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
  const inputPath = await executionInputAbsolutePath(root, opts['execution-id']);
  const answers = join(prefix, 'answers.json');
  const feedback = join(prefix, 'feedback.json');
  for (const name of ['answers.json', 'feedback.json']) if (existsSync(join(prefix, name))) {
    await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/${name}`);
    const info = await lstat(join(prefix, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`Unsafe execution ${name}`);
  }
  const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
  const executionBinding = { ...binding, sandbox };
  // 이 prompt는 실제 작업 절차를 담지 않고, 선택된 skill과 실행 입력으로 안내한다.
  const profileGuide = profile ? providerId === 'claude-code' ? ` Read .claude/agents/${profile}.md and use the matching Claude native subagent for any required independent role.` : ` Read .codex/agents/${profile}.toml.` : '';
  const requiredSkill = providerId === 'claude-code' && guide === publicSkill ? input.skill : null;
  if (requiredSkill && !existsSync(join(root, `.claude/skills/${requiredSkill}/SKILL.md`))) throw new Error(`Claude skill instruction is missing: ${requiredSkill}`);
  const instructions = `The execution workspace is ${root}. Read the execution input at ${inputPath}.${profileGuide}${existsSync(answers) ? ` Read the user's answers from ${answers}.` : ''}${existsSync(feedback) ? ` Read execution feedback from ${feedback} and correct the previous request.` : ''}${sandbox === 'read-only' ? ' This execution cannot write files. Return any newly produced report as result.artifact_contents with a filename, kind and full text; the caller will save it in the session. Include existing artifacts only as references.' : ''} Perform the assigned skill and return its result in the required schema. The caller validates the return and records execution state. Follow the user's stopping conditions in the input.`;
  const prompt = requiredSkill ? adapter.skillPrompt(requiredSkill, instructions) : `Read ${guide}. ${instructions}`;
  const resume = input.context?.resume_session_id;
  const owner = await processIdentity(process.pid);
  if (!owner?.start || !owner.boot) throw new Error('Runner process identity unavailable');
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/process-events.jsonl`);
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/codex.stderr.log`);
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/codex.errors.jsonl`);
  if (providerId === 'claude-code') await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/claude.stdout.log`);
  const eventsFd = openSync(join(prefix, 'process-events.jsonl'), 'wx', 0o600);
  const stderrFd = openSync(join(prefix, 'codex.stderr.log'), 'wx', 0o600);
  const errorsFd = openSync(join(prefix, 'codex.errors.jsonl'), 'wx', 0o600);
  const stdoutFd = providerId === 'claude-code' ? openSync(join(prefix, 'claude.stdout.log'), 'wx', 0o600) : null;
  recordEvent = (event) => appendFileSync(eventsFd, JSON.stringify({ timestamp: new Date().toISOString(), execution_id: input.execution_id, ...event }) + '\n');
  recordEvent({ event: 'runner_started', pid: process.pid, ppid: process.ppid, launcher_pid: Number(process.env.HARNESS_RUNNER_LAUNCHER_PID) || null, caller_pid: Number(process.env.HARNESS_RUNNER_CALLER_PID) || null, background: process.env.HARNESS_RUNNER_BACKGROUND === '1', timeout_ms: null });
  await recordExecutionState({ root, input, binding, status: 'running', owner, runnerClaim: true });
  const record = parseWorktreeRecord(await readFile(opts['worktree-ref'], 'utf8'));
  // 자식 시작 전에 PID를 기록하고, thread ID 수신 후 정본 worktree에 session 연결을 저장한다.
  const heartbeat = setInterval(() => { recordEvent({ event: 'heartbeat' }); process.stderr.write(`${JSON.stringify({ event: 'heartbeat', execution_id: input.execution_id })}\n`); }, 30000);
  heartbeat.unref();
  let result;
  let parentRuns = 0;
  const runParent = async ({ output: parentOutput, prompt: parentPrompt, resume: parentResume }) => {
    const resumeWriteDirs = parentResume && adapter.resumeWriteDirs ? await adapter.resumeWriteDirs(parentResume, process.env) : [];
    const command = adapter.buildCommand({ root, sandbox, resumeWriteDirs, binding, schema: outputSchema, schemaPath: schema, output: parentOutput, resume: parentResume });
    return adapter.run({ root, args: command, prompt: parentPrompt, requiredSkill: parentRuns++ === 0 && !input.context?.interrupted_execution_id ? requiredSkill : null, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'] }, onEvent: recordEvent, onStdout: (data) => { if (stdoutFd !== null) appendFileSync(stdoutFd, data); }, onStderr: (data) => { appendFileSync(stderrFd, data); recordEvent({ event: 'codex_stderr', bytes: data.length }); }, onCodexError: (event) => appendFileSync(errorsFd, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n'), onStart: async (pid) => {
    const child = await processIdentity(pid);
    if (!child?.start || !child.boot) throw new Error('Child process identity unavailable');
    await recordExecutionState({ root, input, binding, status: 'running', owner, child });
    process.stderr.write(`${JSON.stringify({ event: 'started', pid })}\n`);
  }, onSession: async (threadId) => {
    if (parentResume && threadId !== parentResume) throw new Error('Resumed provider session ID mismatch');
    await recordWorkflowSession({ workspace_root: root, repository_root: record.return_root, key: input.context.stage_id, session_id: threadId, execution_id: input.execution_id, provider: providerId });
    process.stderr.write(`${JSON.stringify({ event: 'thread.started', thread_id: threadId })}\n`);
  }, output: parentOutput });
  };
  try {
    result = await runParent({ output, prompt, resume });
  } finally { clearInterval(heartbeat); closeSync(stderrFd); closeSync(errorsFd); if (stdoutFd !== null) closeSync(stdoutFd); }
  await writeFile(join(prefix, 'exec.stderr.json'), JSON.stringify({ provider: providerId, exit_code: result.code, exit_signal: result.signal, stderr: result.stderr, codex_errors: result.errors, session_id: result.sessionId, thread_id: result.threadId, binding: executionBinding }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (resume && result.sessionId !== resume) throw new Error('Resumed Codex session ID mismatch');
  if (result.code === 0) {
    execFileSync(process.execPath, [join(root, '.codex/scripts/harness-result.mjs'), '--root', root, '--worktree-ref', opts['worktree-ref'], '--execution-id', opts['execution-id'], '--source', `runtime/executions/${opts['execution-id']}/codex-last-message.json`], { cwd: root, stdio: 'pipe' });
  }
  process.stdout.write(`${JSON.stringify({ ...result, binding: executionBinding })}\n`);
  recordEvent({ event: 'runner_completed', exit_code: result.code, exit_signal: result.signal });
  closeSync(eventsFd);
  if (result.code !== 0) process.exitCode = 1;
} catch (error) { recordEvent({ event: 'runner_failed', message: error.message }); process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
