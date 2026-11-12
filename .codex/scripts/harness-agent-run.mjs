#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { buildStagePrompt, instructionVersion, isCancellationOutcome, isCompactionEvent, phaseInstructionPaths } from '../../.harness/src/workflow/execution-context.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const base = installed;
const { loadProvider } = await import(new URL('providers/index.mjs', base));
const { resolveSkillBinding, resolveWorkflowStage, resolveAgentSandbox, readExecutionInput, readSkillSessionJson, resolveSkillSession, validateSkillInput } = await import(new URL('skill-execution.mjs', base));
const { stripSkillDeclaration } = await import(new URL('skill-declaration.mjs', base));
const { cliSession } = await import(new URL('cli-session.mjs', base));
const { executionInputAbsolutePath } = await import(new URL('execution-input.mjs', base));
const { stageExecutionPaths, stageArtifactDirectories } = await import(new URL('session-output.mjs', base));
const { inspectWorkspace } = await import(new URL('../eval/workspace-preflight.mjs', base));
const { writeOutputSchema } = await import(new URL('output-schema.mjs', base));
const { recordExecutionState, processIdentity } = await import(new URL('execution-state.mjs', base));
const { parseWorktreeRecord, recordWorkflowSession } = await import(new URL('worktrees.mjs', base));
const { assertWorkspaceTarget } = await import(new URL('../eval/case-workspace.mjs', base));
let recordEvent = () => {};
let eventsFd = null, stderrFd = null, errorsFd = null, stdoutFd = null;
let activeInput = null, activeBinding = null, executionClaimed = false, stageEventPublished = false, cancelRequested = false;
let publishStageResultEvent = null;
try {
  ({ publishStageResultEvent } = await import(new URL('stage-result-events.mjs', base)));
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['worktree-ref', 'execution-id', 'workflow', 'stage', 'background'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  opts['worktree-ref'] = (await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href)).resolveCommandContext({ worktreeRef: opts['worktree-ref'] }).worktree_ref ?? opts['worktree-ref'];
  if (!isAbsolute(opts['worktree-ref'] || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute worktree-ref and execution-id are required');
  if (opts.background && opts.background !== 'true') throw new Error('background must be true');
  const root = process.cwd();
  // 실행 입력과 worktree 참조가 서로 일치하는지 확인한 뒤 skill/profile을 선택한다.
  const session = await cliSession(root, opts['worktree-ref']);
  const workspace = await inspectWorkspace({ workspaceRoot: root, cwd: root });
  if (!workspace.valid) throw new Error(`Execution workspace invalid: ${workspace.reason}; cwd=${workspace.cwd}; git_root=${workspace.git_root}; registered=${workspace.worktree_registered}`);
  const input = await readExecutionInput({ root, execution_id: opts['execution-id'] });
  activeInput = input;
  if (input.execution_id !== opts['execution-id'] || input.context?.worktree_ref !== opts['worktree-ref']) throw new Error('Input does not match the requested execution');
  if (input.context?.parent_execution_id) throw new Error('Internal tasks must run as subagents of their parent stage');
  if (input.skill === 'workflow-compose') throw new Error('Workflow composition is performed by harness-compose-workspace.mjs');
  await validateSkillInput({ root, input });
  const { workflow, stage } = await resolveWorkflowStage({ root, input, workflow: opts.workflow || null, stage: opts.stage || null });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage, workflowBinding: input.context?.workflow_binding || null });
  activeBinding = binding;
  const providerId = input.context?.provider || binding.provider;
  if (providerId !== binding.provider || (input.context?.orchestrator_provider && input.context.orchestrator_provider !== providerId) || (input.context?.resume_provider && input.context.resume_provider !== providerId)) throw new Error('Execution provider must match the orchestrator, configured model binding, and resumed session');
  const adapter = await loadProvider(providerId);
  const paths = stageExecutionPaths(root, input.execution_id);
  if (paths.session !== session) throw new Error('Execution session does not match workspace');
  const prefix = paths.directory;
  const schema = paths.files.schema, output = paths.files.raw;
  if (!existsSync(schema)) await writeOutputSchema({ root, input, prefix: `runtime/executions/${opts['execution-id']}`, path: schema, provider: providerId });
  const schemaInfo = await lstat(schema);
  if (!schemaInfo.isFile() || schemaInfo.isSymbolicLink()) throw new Error('Output schema must be a regular file');
  const outputSchema = JSON.parse(await readFile(schema, 'utf8'));
  if (Object.hasOwn(outputSchema.properties || {}, 'execution_id') || outputSchema.properties?.skill?.const !== input.skill) throw new Error('Output schema does not match the execution input');
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
  const answers = paths.files.answers;
  const feedback = paths.files.feedback;
  for (const name of ['answers.json', 'feedback.json']) if (existsSync(join(prefix, name))) {
    await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/${name}`);
    const info = await lstat(join(prefix, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`Unsafe execution ${name}`);
  }
  const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
  const executionBinding = { ...binding, sandbox };
  // Runner owns instruction delivery so resumes can omit unchanged bodies.
  const profilePath = profile ? providerId === 'claude-code' ? `.claude/agents/${profile}.md` : `.codex/agents/${profile}.toml` : null;
  const requiredSkill = providerId === 'claude-code' && guide === publicSkill ? input.skill : null;
  if (requiredSkill && !existsSync(join(root, `.claude/skills/${requiredSkill}/SKILL.md`))) throw new Error(`Claude skill instruction is missing: ${requiredSkill}`);
  const resume = input.context?.resume_session_id;
  const controlSession = input.context?.control_session_directory || input.session_directory;
  let priorStage = null;
  try {
    const statePath = input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json';
    const stateRecord = await readSkillSessionJson({ root, session_directory: controlSession, path: statePath });
    priorStage = (stateRecord.state || stateRecord).stages?.[input.context?.stage_id || input.skill] || null;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let priorCompaction = Boolean(priorStage?.instruction_delivery?.compaction_observed);
  if (!priorCompaction && priorStage?.execution_id) {
    const priorEvents = `runtime/executions/${priorStage.execution_id}/process-events.jsonl`;
    const priorSession = priorStage.result_session_directory ? await resolveSkillSession(root, priorStage.result_session_directory) : session;
    await assertWorkspaceTarget(priorSession, priorEvents);
    try { priorCompaction = (await readFile(join(priorSession, priorEvents), 'utf8')).split('\n').some((line) => { try { return isCompactionEvent(JSON.parse(line)); } catch { return false; } }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The model declaration in a skill document is metadata for the runner; the stage receives the instructions without it.
  const guideContent = stripSkillDeclaration(await readFile(join(root, guide), 'utf8'));
  const workerBase = providerId === 'claude-code' ? await readFile(join(root, '.codex/internal-skills/skill-execution/worker-base.md'), 'utf8') : null;
  const profileContent = profilePath ? await readFile(join(root, profilePath), 'utf8') : null;
  const profileVersion = profileContent === null ? null : instructionVersion(profileContent);
  const returnContract = '.codex/internal-skills/skill-execution/references/stage-return.md';
  const instructionPaths = [returnContract, ...(input.skill === 'spec-me' ? ['.codex/internal-skills/skill-execution/GUIDE.md', '.codex/internal-skills/product-spec/GUIDE.md', '.codex/internal-skills/product-spec/references/topics.md', '.codex/internal-skills/product-spec/references/template.md'] : input.skill === 'product-spec' ? ['.codex/internal-skills/skill-execution/GUIDE.md', '.codex/internal-skills/product-spec/references/topics.md', '.codex/internal-skills/product-spec/references/template.md'] : [])];
  const instructionVersions = await Promise.all(instructionPaths.map(async (path) => [path, instructionVersion(stripSkillDeclaration(await readFile(join(root, path), 'utf8')))]));
  const artifactDirectories = input.context?.plan_set_id ? stageArtifactDirectories(root, input.context.plan_set_id) : null;
  const activeInstructionPaths = phaseInstructionPaths({ skill: input.skill, productSpecExists: Boolean(artifactDirectories && existsSync(join(artifactDirectories.specs, 'product-spec.md'))) });
  const instructionContents = await Promise.all(activeInstructionPaths.map(async (path) => { const content = stripSkillDeclaration(await readFile(join(root, path), 'utf8')); return { path, content, version: instructionVersion(content) }; }));
  const previousDelivery = priorStage?.instruction_delivery ? { ...priorStage.instruction_delivery, compaction_observed: priorCompaction } : null;
  const { prompt: instructions, delivery } = buildStagePrompt({ guide, guideContent, guideVersion: instructionVersion(guideContent), profile: profilePath, profileContent, profileVersion, instructionVersions, instructionContents, resumeSession: resume, previousDelivery, answersPath: existsSync(answers) ? answers : null, feedbackPath: existsSync(feedback) ? feedback : null, sandbox, root, inputPath, executionDirectory: paths.directory, artifactDirectories, workflowPhase: input.context?.phase || null });
  const prompt = requiredSkill ? adapter.skillPrompt(requiredSkill, instructions) : instructions;
  const owner = await processIdentity(process.pid);
  if (!owner?.start || !owner.boot) throw new Error('Runner process identity unavailable');
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/process-events.jsonl`);
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/codex.stderr.log`);
  await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/codex.errors.jsonl`);
  if (providerId === 'claude-code') await assertWorkspaceTarget(session, `runtime/executions/${opts['execution-id']}/claude.stdout.log`);
  eventsFd = openSync(join(prefix, 'process-events.jsonl'), 'wx', 0o600);
  stderrFd = openSync(join(prefix, 'codex.stderr.log'), 'wx', 0o600);
  errorsFd = openSync(join(prefix, 'codex.errors.jsonl'), 'wx', 0o600);
  stdoutFd = providerId === 'claude-code' ? openSync(join(prefix, 'claude.stdout.log'), 'wx', 0o600) : null;
  recordEvent = (event) => appendFileSync(eventsFd, JSON.stringify({ timestamp: new Date().toISOString(), execution_id: input.execution_id, ...event }) + '\n');
  recordEvent({ event: 'runner_started', pid: process.pid, ppid: process.ppid, launcher_pid: Number(process.env.HARNESS_RUNNER_LAUNCHER_PID) || null, caller_pid: Number(process.env.HARNESS_RUNNER_CALLER_PID) || null, background: process.env.HARNESS_RUNNER_BACKGROUND === '1', timeout_ms: null });
  await recordExecutionState({ root, input, binding, status: 'running', owner, runnerClaim: true, instruction_delivery: delivery });
  executionClaimed = true;
  const record = parseWorktreeRecord(await readFile(opts['worktree-ref'], 'utf8'));
  // 자식 시작 전에 PID를 기록하고, thread ID 수신 후 정본 worktree에 session 연결을 저장한다.
  const heartbeat = setInterval(() => { recordEvent({ event: 'heartbeat' }); process.stderr.write(`${JSON.stringify({ event: 'heartbeat', execution_id: input.execution_id })}\n`); }, 30000);
  heartbeat.unref();
  let result;
  let parentRuns = 0;
  let compactionObserved = false;
  const runParent = async ({ output: parentOutput, prompt: parentPrompt, resume: parentResume }) => {
    const resumeWriteDirs = parentResume && adapter.resumeWriteDirs ? await adapter.resumeWriteDirs(parentResume, process.env) : [];
    const invocationSkill = parentRuns++ === 0 && !input.context?.interrupted_execution_id ? requiredSkill : null;
    const command = await adapter.buildCommand({ root, sandbox, resumeWriteDirs, binding, schema: outputSchema, schemaPath: schema, output: parentOutput, resume: parentResume, role: profile, skill: input.skill, stageId: input.context?.stage_id, requiredSkill: invocationSkill, workerBase, env: process.env });
    return adapter.run({ root, args: command, prompt: parentPrompt, requiredSkill: invocationSkill, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_CONTROL_SESSION_DIR: input.context?.control_session_directory || session, HARNESS_SKILL_EXECUTION_ID: opts['execution-id'], HARNESS_WORKSPACE_ROOT: root, HARNESS_PROVIDER_ID: providerId, HARNESS_REVIEW_EXECUTION_ID: opts['execution-id'], HARNESS_REVIEW_TICKET_ID: input.context?.plan_set_id || '' }, onEvent: (event) => { recordEvent(event); if (event.event === 'runner_signal') cancelRequested = true; if (isCompactionEvent(event)) compactionObserved = true; }, onStdout: (data) => { if (stdoutFd !== null) appendFileSync(stdoutFd, data); }, onStderr: (data) => { appendFileSync(stderrFd, data); recordEvent({ event: 'codex_stderr', bytes: data.length }); }, onCodexError: (event) => appendFileSync(errorsFd, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n'), onStart: async (pid) => {
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
  } finally {
    clearInterval(heartbeat);
    if (compactionObserved) await recordExecutionState({ root, input, binding, status: 'running', owner, instruction_delivery: { ...delivery, compaction_observed: true } });
    closeSync(stderrFd); stderrFd = null; closeSync(errorsFd); errorsFd = null; if (stdoutFd !== null) { closeSync(stdoutFd); stdoutFd = null; }
  }
  await writeFile(join(prefix, 'exec.stderr.json'), JSON.stringify({ provider: providerId, exit_code: result.code, exit_signal: result.signal, stderr: result.stderr, codex_errors: result.errors, session_id: result.sessionId, thread_id: result.threadId, binding: executionBinding }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (resume && result.sessionId !== resume) throw new Error('Resumed Codex session ID mismatch');
  if (result.code === 0) {
    if (providerId === 'claude-code' && input.skill === 'spec-me' && input.context?.plan_set_id) {
      const { assertNoUnrecordedNativeReview } = await import(new URL('review-attempts.mjs', base));
      await assertNoUnrecordedNativeReview({ root, scope: `spec-${input.context.plan_set_id}-architecture` });
    }
    if (providerId === 'claude-code' && input.skill === 'to-ticket' && input.context?.plan_set_id) {
      const { assertNoUnrecordedNativeReview } = await import(new URL('review-attempts.mjs', base));
      await assertNoUnrecordedNativeReview({ root, scope: `plan-${input.context.plan_set_id}` });
    }
    if (providerId === 'claude-code' && input.skill === 'sync-contracts' && input.context?.plan_set_id) {
      const { assertNoUnrecordedNativeReview } = await import(new URL('review-attempts.mjs', base));
      await assertNoUnrecordedNativeReview({ root, scope: `contracts-${input.context.plan_set_id}` });
    }
    const { commitStageRequest, commitWorkflowDocuments } = await import(new URL('stage-commit.mjs', base));
    await commitStageRequest({ root, rawPath: output });
    execFileSync(process.execPath, [join(root, '.codex/scripts/harness-result.mjs'), '--root', root, '--worktree-ref', opts['worktree-ref'], '--execution-id', opts['execution-id'], '--source', paths.refs.raw], { cwd: root, stdio: 'pipe' });
    // The stage's documents are committed only after its result passed validation, so an incomplete Spec is never recorded as done.
    await commitWorkflowDocuments({ root, input, rawPath: output });
    const envelope = await readSkillSessionJson({ root, session_directory: input.session_directory, path: paths.refs.returned });
    const published = await publishStageResultEvent({ root, input, envelope, binding, hostDelivery: true });
    if (published.status !== envelope.status || published.code !== envelope.code) {
      recordEvent({ event: 'stage_result_failed', status: published.status, code: published.code, message: published.summary });
      process.exitCode = 1;
    }
    stageEventPublished = true;
  } else {
    // A stalled run was stopped by the watchdog, not cancelled by the user; it is reported as a failure the orchestrator resumes.
    const cancelled = !result.stalled && isCancellationOutcome({ requested: cancelRequested, signal: result.signal, code: result.code });
    const error = Object.assign(new Error(result.stalled ? 'Stage stalled: the provider wrote nothing for too long and was stopped; resume the stage' : `Stage provider exited with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`), { name: cancelled ? 'AbortError' : 'Error' });
    await publishStageResultEvent({ root, input, binding, error, reason: error.message, hostDelivery: true });
    stageEventPublished = true;
  }
  process.stdout.write(`${JSON.stringify({ ...result, binding: executionBinding })}\n`);
  recordEvent({ event: 'runner_completed', exit_code: result.code, exit_signal: result.signal });
  closeSync(eventsFd); eventsFd = null;
  if (result.code !== 0) process.exitCode = 1;
} catch (error) {
  if (eventsFd !== null) recordEvent({ event: 'runner_failed', message: error.message });
  for (const fd of [stderrFd, errorsFd, stdoutFd, eventsFd]) if (fd !== null) { try { closeSync(fd); } catch {} }
  stderrFd = errorsFd = stdoutFd = eventsFd = null;
  if (executionClaimed && activeInput && !stageEventPublished && publishStageResultEvent) {
    try { await publishStageResultEvent({ root: activeInput.workspace_root, input: activeInput, binding: activeBinding, error, reason: error.message, hostDelivery: true }); stageEventPublished = true; }
    catch (eventError) { process.stderr.write(`${JSON.stringify({ event_error: eventError.message })}\n`); }
  }
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1;
}
