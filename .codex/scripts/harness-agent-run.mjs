#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const base = installed;
const { loadProvider, configuredProvider } = await import(new URL('providers/index.mjs', base));
const { resolveSkillBinding, resolveWorkflowStage, resolveAgentSandbox, readExecutionInput, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { parseYaml } = await import(new URL('../eval/yaml.mjs', base));
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
  // 실행 입력과 worktree 참조가 서로 일치하는지 확인한 뒤 skill/profile을 선택한다.
  const session = await cliSession(root, opts['worktree-ref']);
  const input = await readExecutionInput({ root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id'] || input.context?.worktree_ref !== opts['worktree-ref']) throw new Error('Input does not match the requested execution');
  if (input.context?.parent_execution_id) throw new Error('Internal tasks must run as subagents of their parent stage');
  if (input.skill === 'workflow-compose') throw new Error('Workflow composition is performed by harness-compose-workspace.mjs');
  await validateSkillInput({ root, input });
  const { workflow, stage } = await resolveWorkflowStage({ root, input, workflow: opts.workflow || null, stage: opts.stage || null });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage });
  const providerId = input.context?.provider || binding.provider || configuredProvider(parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8')));
  if (input.context?.resume_provider && input.context.resume_provider !== providerId) throw new Error('A stage must resume with the provider that started it');
  const adapter = await loadProvider(providerId);
  const prefix = join(session, 'runtime/executions', opts['execution-id']);
  const schema = join(prefix, 'return.schema.json'), output = join(prefix, 'return.json');
  if (!existsSync(schema)) await writeOutputSchema({ root, input, prefix: `runtime/executions/${opts['execution-id']}`, path: schema, provider: providerId });
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
  const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
  const executionBinding = { ...binding, sandbox };
  // 이 prompt는 실제 작업 절차를 담지 않고, 선택된 skill과 실행 입력으로 안내한다.
  const profileGuide = profile ? providerId === 'claude-code' ? ` Read .claude/agents/${profile}.md and use the matching Claude native subagent for any required independent role.` : ` Read .codex/agents/${profile}.toml.` : '';
  const prompt = `Read ${guide} and ${location.path}.${profileGuide}${existsSync(answers) ? ` Read the user's answers from ${answers}.` : ''}${existsSync(feedback) ? ` Read execution feedback from ${feedback} and correct the previous request.` : ''}${sandbox === 'read-only' ? ' This execution cannot write files. Return any newly produced report as result.artifact_contents with a filename, kind and full text; the caller will save it in the session. Include existing artifacts only as references.' : ''} Perform the assigned skill and return its result in the required schema. The caller validates the return and records execution state. Follow the user's stopping conditions in the input.`;
  const resume = input.context?.resume_session_id;
  const writeDirs = adapter.resumeWriteDirs ? (resume ? await adapter.resumeWriteDirs(resume, process.env) : []) : [];
  const command = adapter.buildCommand({ root, sandbox, resumeWriteDirs: writeDirs, binding, schema: outputSchema, schemaPath: schema, output, resume });
  const owner = await processIdentity(process.pid);
  if (!owner?.start || !owner.boot) throw new Error('Runner process identity unavailable');
  await recordExecutionState({ root, input, binding, status: 'running', owner, runnerClaim: true });
  const record = parseWorktreeRecord(await readFile(opts['worktree-ref'], 'utf8'));
  // 자식 시작 전에 PID를 기록하고, thread ID 수신 후 정본 worktree에 session 연결을 저장한다.
  const result = await adapter.run({ root, args: command, prompt, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'] }, output, onStart: async (pid) => {
    const child = await processIdentity(pid);
    if (!child?.start || !child.boot) throw new Error('Child process identity unavailable');
    await recordExecutionState({ root, input, binding, status: 'running', owner, child });
    process.stderr.write(`${JSON.stringify({ event: 'started', pid })}\n`);
  }, onSession: async (sessionId) => {
    if (resume && sessionId !== resume) throw new Error(`Resumed ${providerId} session ID mismatch`);
    await recordWorkflowSession({ workspace_root: root, repository_root: record.return_root, key: input.context.stage_id, session_id: sessionId, execution_id: input.execution_id, provider: providerId });
    process.stderr.write(`${JSON.stringify({ event: 'session.started', provider: providerId, session_id: sessionId })}\n`);
  } });
  await writeFile(join(prefix, 'exec.stderr.json'), JSON.stringify({ provider: providerId, exit_code: result.code, stderr: result.stderr, errors: result.errors, session_id: result.sessionId || result.threadId, thread_id: result.threadId, binding: executionBinding }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (resume && (result.sessionId || result.threadId) !== resume) throw new Error(`Resumed ${providerId} session ID mismatch`);
  process.stdout.write(`${JSON.stringify({ ...result, binding: executionBinding })}\n`);
  if (result.code !== 0) process.exitCode = 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
