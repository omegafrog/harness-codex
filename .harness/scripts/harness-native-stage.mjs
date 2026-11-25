#!/usr/bin/env node
import { constants, existsSync, statSync } from 'node:fs';
import { open, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertWorkspaceTarget } from '../../.harness/src/eval/case-workspace.mjs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliSession } from '../../.harness/src/workflow/cli-session.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { executionInputAbsolutePath } from '../../.harness/src/workflow/execution-input.mjs';
import { recordExecutionState } from '../../.harness/src/workflow/execution-state.mjs';
import { readExecutionInput, readSkillSessionJson, resolveAgentSandbox, resolveSkillBinding, resolveWorkflowStage, validateSkillInput } from '../../.harness/src/workflow/stage-runtime.mjs';
import { sessionOutputPath, stageExecutionPaths } from '../../.harness/src/workflow/session-output.mjs';
import { archiveWriterComposition, authorsOwnDocuments, persistAuthoredBatch, assertStageDocumentWriterCompleted, authenticateWriterCommand, bindStageDocumentWriter, finishedWriterBatch, prepareStageDocumentDrafts, prepareWriterBrief, readWriterAssignment, readWriterBatch, receiveWriterComposition, rollbackStageDocumentWrite, stageDocumentBatch, stageDocumentPolicy, writeStageDocumentBatch } from '../../.harness/src/workflow/stage-documents.mjs';
import { validateOutputFormat, writeOutputSchema } from '../../.harness/src/workflow/output-schema.mjs';
import { writeImplementationCheckpoint } from '../../.harness/src/workflow/stage-checkpoint.mjs';
import { preSpecOrderViolation, tacticalImplementationOrderViolation } from '../../.harness/src/workflow/worktree-stages.mjs';
import { TAKEOVER_FEEDBACK, contextCommand, compactFinished, compactStarted, extractVerbose, foreignRunningStage, formatErrorResult, gateErrorResult, launchAttemptDirectory, launchChildError, launchResult, compactPrepared, nativeCommand, nativeReceiveCommand, outputMissingResult, receiveRecoveryError, takeoverStep, writeError } from '../../.harness/src/workflow/stage-cli.mjs';

// What the error output needs to know about this call.
const errorContext = { script: 'native-stage', action: undefined, executionId: undefined, stageId: undefined, root: undefined };

const PROCESS_EVIDENCE_LIMIT = 64 * 1024;
const SPAWN_REFUSALS = new Set(['E2BIG', 'EACCES', 'ENOENT', 'ENOTDIR', 'EPERM']);
const validExecutionId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);

async function printWriterPending(root, batch) {
  const id = batch.execution_id;
  const assigned = await readWriterAssignment(root, id);
  process.stdout.write(`${JSON.stringify({ status: assigned ? 'writer_running' : 'writer_required', execution_id: id, agent_profile: batch.agent_profile, binding: batch.binding, dispatch_owner: batch.binding.provider === 'claude-code' || batch.phase !== 'review' ? 'orchestrator' : 'stage_worker', ...(assigned ? { agent_id: assigned.agent_id } : {}), next: { ...(assigned ? {} : { bind: nativeCommand('bind-writer', id, '--agent-id <writer_agent_id>') }), finish: nativeCommand('finish', id) } })}\n`);
}

const reviewedDocuments = (skill) => ['to-ticket', 'sync-contracts'].includes(skill);
const reviewScope = (skill, planSetId) => `${skill === 'to-ticket' ? 'plan' : 'contracts'}-${planSetId}`;

async function printClaudeReviewHandoff({ root, input, planSetId, current }) {
  const { inspectActiveReviewAttempt } = await import('../../.harness/src/workflow/review-attempts.mjs');
  let attempt;
  try { attempt = await inspectActiveReviewAttempt({ root, scope: reviewScope(input.skill, planSetId) }); }
  catch (error) { if (error.message === 'No active review attempt') return false; throw error; }
  const id = input.execution_id;
  if (attempt.admission_execution_id && attempt.admission_execution_id !== id || attempt.native_review && attempt.native_review.execution_id !== id) {
    throw new Error('The active independent review belongs to a different stage execution');
  }
  const review = { attempt_id: attempt.attempt_id, agent_profile: input.skill === 'to-ticket' ? 'plan_reviewer' : 'contract_reviewer',
    ...(attempt.admission_ref ? { reviewer_input_ref: attempt.admission_ref } : {}) };
  const native = attempt.native_review;
  const status = native ? native.stopped ? 'review_record_required' : 'review_running' : 'review_dispatch_required';
  process.stdout.write(`${JSON.stringify({ status, execution_id: id, agent_id: current.native_agent_id, review,
    ...(native?.agent_id ? { reviewer_agent_id: native.agent_id } : {}), next: nativeCommand('finish', id) })}\n`);
  return true;
}

async function archiveRejectedSubmission(root, paths, id) {
  const backup = sessionOutputPath(root, `runtime/executions/${id}/document-drafts/rejected-result-${randomUUID()}.json`);
  await rename(paths.files.raw, backup);
}

function lastJson(text) {
  const output = String(text || '').trimEnd();
  try {
    const parsed = JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function runStageCommand(command, { cwd, env, phase } = {}) {
  const startedAt = new Date().toISOString();
  let child;
  try {
    child = spawnSync(command[0], command.slice(1), { cwd, env, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { child = { error }; }
  const stream = (output) => Buffer.isBuffer(output) ? output : Buffer.from(output || '');
  const stdout = stream(child.stdout), stderr = stream(child.stderr);
  const metadata = {
    schema_version: 1,
    // Launch arguments can include user answers and feedback. The command identity is sufficient for diagnosis.
    command: phase ? command.slice(0, 2) : command,
    ...(phase ? { phase } : {}),
    cwd,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pid: child.pid || null,
    exit_code: child.status ?? null,
    signal: child.signal || null,
    spawn_error: child.error ? { name: child.error.name, message: child.error.message.slice(0, 1024), code: child.error.code || null } : null,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_truncated: stdout.length > PROCESS_EVIDENCE_LIMIT,
    stderr_truncated: stderr.length > PROCESS_EVIDENCE_LIMIT,
  };
  return { metadata, stdout, stderr };
}

async function saveStageCommand(root, directory, run) {
  const refs = { stdout_path: `${directory}/stdout.log`, stderr_path: `${directory}/stderr.log`, process_path: `${directory}/process.json` };
  const paths = Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, sessionOutputPath(root, ref)]));
  const options = { flag: 'wx', mode: 0o600 };
  const metadata = { ...run.metadata, ...refs };
  await writeFile(paths.stdout_path, run.stdout.subarray(-PROCESS_EVIDENCE_LIMIT), options);
  await writeFile(paths.stderr_path, run.stderr.subarray(-PROCESS_EVIDENCE_LIMIT), options);
  await writeFile(paths.process_path, `${JSON.stringify(metadata, null, 2)}\n`, options);
  return metadata;
}

async function persistGateRejection({ session, paths, gate, stage, executionId, errors, instruction }) {
  await assertWorkspaceTarget(session, paths.refs.feedback);
  let previous = {};
  try {
    const file = await open(paths.files.feedback, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('Stage feedback must be a regular unshared file');
      previous = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Stage feedback must contain a JSON object');
  const rejection = { gate, stage, execution_id: executionId, errors, instruction, rejected_at: new Date().toISOString() };
  const feedback = { ...previous, gate_rejections: [...(Array.isArray(previous.gate_rejections) ? previous.gate_rejections : []), rejection] };
  const file = await open(paths.files.feedback, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Stage feedback must be a regular unshared file');
    await file.truncate(0);
    await file.writeFile(JSON.stringify(feedback, null, 2) + '\n');
  } finally { await file.close(); }
  return feedback;
}

async function printGateError({ session, paths, gate, stage, executionId, errors, instruction }) {
  const feedback = await persistGateRejection({ session, paths, gate, stage, executionId, errors, instruction });
  const retryInput = { feedback_path: paths.files.feedback, feedback, gate_rejection: feedback.gate_rejections.at(-1) };
  process.stdout.write(`${JSON.stringify(gateErrorResult({ gate, executionId, stage, errors, instruction, outputPath: paths.files.raw, feedbackPath: paths.files.feedback, retryInput }))}\n`);
}

// Stage-binding validation is handled separately before taking over the requested stage.
function takeOverStage(args) {
  const index = args.indexOf('--take-over');
  if (index < 0) return null;
  const rest = args.filter((_, i) => i !== index && i !== index + 1);
  // --plan names the ticket the resumed run builds; it is only needed when the interrupted run's input was lost.
  const planIndex = rest.indexOf('--plan');
  const plan = planIndex < 0 ? null : rest[planIndex + 1];
  const core = planIndex < 0 ? rest : rest.filter((_, i) => i !== planIndex && i !== planIndex + 1);
  if (args[index + 1] !== 'true' || core.length !== 2 || core[0] !== '--stage-id' || !core[1] || (planIndex >= 0 && (!plan || plan.startsWith('--')))) throw new Error('Taking over an interrupted stage must be requested alone');
  return { stage: core[1], plan };
}

// prepare + start in one call: the orchestrator gets exactly what it needs to spawn the subagent and then bind it.
// With --take-over true the stage an ended Codex conversation left running is first recorded as interrupted and
// this conversation (Codex or Claude Code) becomes the orchestrator; the launch then resumes that stage with a fresh execution.
async function launchStage(requestedArgs, verbose) {
  const scripts = fileURLToPath(new URL('.', import.meta.url));
  const attemptId = randomUUID();
  const directory = launchAttemptDirectory(attemptId);
  const receiptRef = `${directory}/prepared.json`;
  const stageIndex = requestedArgs.findIndex((argument, index) => index % 2 === 0 && argument === '--stage-id');
  const stageId = stageIndex < 0 ? undefined : requestedArgs[stageIndex + 1];
  errorContext.stageId = stageId;
  const launchWorkspace = async () => {
    const context = resolveCommandContext();
    return context.worktree_ref ? { ...context, session: await cliSession(context.root, context.worktree_ref) } : null;
  };
  const run = (script, scriptArgs, phase) => runStageCommand([process.execPath, join(scripts, script), ...scriptArgs], {
    cwd: process.cwd(), phase,
    ...(phase === 'prepare' ? { env: { ...process.env, HARNESS_NATIVE_LAUNCH_ATTEMPT_ID: attemptId } } : {}),
  });
  const succeeded = ({ metadata }) => metadata.exit_code === 0 && !metadata.spawn_error;

  async function preparedReceipt(root) {
    const file = await open(sessionOutputPath(root, receiptRef, { create: false }), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024) return null;
      return JSON.parse(await file.readFile('utf8')).execution_id;
    } finally { await file.close(); }
  }

  async function confirmedPreparedId({ root, session, worktree_ref }, printedId) {
    const id = printedId || await preparedReceipt(root);
    if (!validExecutionId(id)) return null;
    const input = await readExecutionInput({ root, execution_id: id });
    if (input.session_directory !== session || input.context?.worktree_ref !== worktree_ref || input.context?.stage_id !== stageId) return null;
    await validateSkillInput({ root, input });
    return id;
  }

  async function launchFailure(run, knownExecutionId) {
    const phase = run.metadata.phase;
    const context = await launchWorkspace().catch(() => null);
    const preparedExecutionId = phase === 'prepare' && context ? await confirmedPreparedId(context, knownExecutionId).catch(() => null) : knownExecutionId;
    const startWasRefused = phase === 'start' && !run.metadata.pid && SPAWN_REFUSALS.has(run.metadata.spawn_error?.code);
    const canStart = Boolean(preparedExecutionId && (phase === 'prepare' || startWasRefused));
    const printed = !succeeded(run) && lastJson(run.stderr);
    const explained = typeof printed?.error === 'string' && typeof printed.code === 'string' && typeof printed.why === 'string' ? printed : null;
    let command = run.metadata, evidenceError = 'No registered launch workspace';
    if (context) {
      try {
        command = await saveStageCommand(context.root, directory, run);
        evidenceError = undefined;
      } catch (error) { evidenceError = error.code || error.message; }
    }
    const payload = launchChildError({ phase, missingResult: succeeded(run), command, preparedExecutionId, canStart, explained, evidenceError });
    return Object.assign(new Error(payload.error), { explained: payload });
  }

  const bindingIndex = requestedArgs.indexOf('--stage-binding');
  const bindingArgs = bindingIndex < 0 ? [] : requestedArgs.slice(bindingIndex, bindingIndex + 2);
  if (bindingIndex >= 0 && (!bindingArgs[1] || bindingArgs[1].startsWith('--') || requestedArgs.lastIndexOf('--stage-binding') !== bindingIndex)) throw new Error('Invalid argument: --stage-binding requires one JSON value');
  const takeOver = takeOverStage(requestedArgs.filter((_, i) => bindingIndex < 0 || (i !== bindingIndex && i !== bindingIndex + 1)));
  const takeOverId = takeOver?.stage ?? null;
  let args = requestedArgs, taken = null;
  if (takeOverId) {
    errorContext.stageId = takeOverId;
    const takeover = run('harness-prepare-input.mjs', ['--stage-id', takeOverId, '--take-over-interrupted', 'true', ...bindingArgs], 'takeover');
    taken = lastJson(takeover.stdout);
    if (!succeeded(takeover) || taken?.status !== 'ready' || taken.stage_id !== takeOverId || !validExecutionId(taken.execution_id)) throw await launchFailure(takeover);
    // The resumed run builds the same ticket: --plan from the caller, else the plan the interrupted run recorded.
    const plan = takeOver.plan || taken.plan_id;
    args = ['--stage-id', takeOverId, ...(plan ? ['--plan', plan] : []), '--feedback', TAKEOVER_FEEDBACK, ...bindingArgs];
  }
  const prepare = run('harness-prepare-input.mjs', [...args, '--verbose'], 'prepare');
  const prepared = lastJson(prepare.stdout);
  const id = prepared?.input?.execution_id;
  const hasInput = validExecutionId(id) && prepared.input.context?.stage_id === stageId;
  const noStart = !prepared?.input && (prepared?.waiting_for_answers === true || (prepared?.status === 'clarification_needed' && prepared.stage_id === stageId) || prepared?.waiting_for_running_stage === true || (prepared?.status === 'ready' && prepared.stage_id === stageId));
  if (!succeeded(prepare) || (!hasInput && !noStart)) throw await launchFailure(prepare, hasInput ? id : undefined);
  // A saved answer, a partial answer batch or a restart/discard does not start a stage: show what prepare reports.
  if (!hasInput) return verbose ? prepared : compactPrepared(prepared);
  errorContext.executionId = id;
  const start = run('harness-native-stage.mjs', ['start', '--execution-id', id, ...(verbose ? ['--verbose'] : [])], 'start');
  const started = lastJson(start.stdout);
  if (!succeeded(start) || !started?.binding || !['input_path', 'guide', 'schema_path', 'output_path', 'agent_profile'].every((field) => typeof started[field] === 'string' && started[field]) || (verbose && started.execution_id !== id)) throw await launchFailure(start, id);
  try {
    const context = await launchWorkspace();
    if (context) {
      await unlink(sessionOutputPath(context.root, receiptRef, { create: false }));
      await rmdir(sessionOutputPath(context.root, directory, { create: false }));
    }
  } catch { /* Cleanup must not replace a valid launch result. */ }
  const launched = launchResult({ prepared, started });
  const takenOver = taken ? { taken_over: { previous_execution_id: taken.execution_id, previous_session_id: taken.previous_session_id, verified: taken.verified, ...(verbose ? { backup: taken.backup } : {}) } } : {};
  return verbose ? { ...launched, ...takenOver, input: prepared.input } : { ...launched, ...takenOver };
}

// `answer --text '<reply>'` is `launch --answer-text '<reply>'` without a stage: the waiting stage is the one whose questions
// (or approval gate) the reply is for.
function answerArguments(args) {
  const textIndex = args.indexOf('--text');
  if (textIndex < 0 || args.length - 2 > 2 || args.filter((argument, index) => index % 2 === 0 && argument.startsWith('--')).some((argument) => !['--text', '--stage-binding'].includes(argument))) throw new Error("Usage: harness-native-stage.mjs answer --text '<the user's reply verbatim>'");
  return args.map((argument) => argument === '--text' ? '--answer-text' : argument);
}

// Turns --answer-text into the existing --answer / approval options (or a clarification request), see answer-text.mjs.
async function withAnswerText(args) {
  const revisionIndex = args.findIndex((argument, position) => position % 2 === 0 && argument === '--revise-text');
  const index = revisionIndex >= 0 ? revisionIndex : args.findIndex((argument, position) => position % 2 === 0 && argument === '--answer-text');
  if (index < 0) return { args };
  const text = args[index + 1];
  if (typeof text !== 'string' || !text.trim()) throw new Error('The reply for --answer-text must not be empty');
  const rest = args.filter((_, position) => position !== index && position !== index + 1);
  const stageIndex = rest.findIndex((argument, position) => position % 2 === 0 && argument === '--stage-id');
  const named = stageIndex < 0 ? null : rest[stageIndex + 1];
  const { resolveReplyTarget, resolveRevision } = await import('../../.harness/src/workflow/answer-text.mjs');
  const target = (revisionIndex >= 0 ? resolveRevision : resolveReplyTarget)(resolveCommandContext().root, text);
  const refuse = (message, next) => Object.assign(new Error(message), { explained: { error: message, code: 'ANSWER_REFUSED', why: message, next } });
  if (target.error) throw refuse(target.error, [contextCommand()]);
  if (named && !target.revision && named !== target.stageId) throw refuse(`${target.stageId} is the stage waiting for this reply, not ${named}.`, [`Pass the reply without naming a stage: node .harness/scripts/harness-native-stage.mjs answer --text '<the user's reply verbatim>'`]);
  if (target.clarification) return { result: { status: 'clarification_needed', stage_id: target.stageId, message: target.clarification, next: target.revision ? 'Ask the user in Korean which part to change, then pass their new text verbatim as a revise request. Nothing was started.' : 'Ask the user in Korean to clarify, then pass their new reply verbatim with the same answer command. Nothing was recorded.' } };
  return { args: [...target.args, ...(stageIndex < 0 ? rest : rest.filter((_, position) => position !== stageIndex && position !== stageIndex + 1))] };
}

const NATIVE_STAGE_USAGE = 'Usage: harness-native-stage.mjs launch --stage-id STAGE [prepare options] | answer --text \'<reply>\' | start|inspect|reconcile|recover-interrupted|bind|receive|finish|fail|cancel --execution-id ID [--agent-id ID] [--reason TEXT] (run inside the workflow worktree; --root and --worktree-ref are found automatically). Prepare options: see harness-prepare-input.mjs --help';
if (['--help', '-h'].includes(process.argv[2])) { process.stdout.write(`${NATIVE_STAGE_USAGE}\n`); process.exit(0); }
try {
  const [requestedAction, ...rest] = process.argv.slice(2), opts = {};
  let action = requestedAction;
  errorContext.action = action;
  const { args, verbose } = extractVerbose(rest);
  if (action === 'launch' || action === 'answer') {
    const requested = await withAnswerText(action === 'answer' ? answerArguments(args) : args);
    const launched = requested.result ?? await launchStage(requested.args, verbose);
    await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(launched)}\n`, (error) => error ? reject(error) : resolve()));
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'reason', 'agent-id', 'repair-binding'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid native stage arguments');
    opts[key] = args[i + 1];
  }
  if (!['start', 'inspect', 'reconcile', 'recover-interrupted', 'bind', 'receive', 'draft-ready', 'bind-writer', 'write-documents', 'finish', 'fail', 'cancel'].includes(action) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Usage: harness-native-stage.mjs launch --stage-id STAGE [prepare options] | start|inspect|reconcile|recover-interrupted|bind|receive|draft-ready|bind-writer|write-documents|finish|fail|cancel --execution-id ID [--agent-id ID] [--reason TEXT] (run inside the workflow worktree; --root and --worktree-ref are found automatically)');
  errorContext.executionId = opts['execution-id'];
  // --root and --worktree-ref are optional: the current worktree supplies them, and an explicit value must match it.
  const commandContext = resolveCommandContext({ root: opts.root, worktreeRef: opts['worktree-ref'] });
  if (!commandContext.worktree_ref) throw new Error(`Workflow commands require a registered linked worktree; change directory to the target worktree: no workflow worktree was found at ${commandContext.root}`);
  opts.root ??= commandContext.root;
  opts['worktree-ref'] ??= commandContext.worktree_ref;
  if (!isAbsolute(opts.root || '')) throw new Error('Invalid native stage arguments');
  const root = opts.root, id = opts['execution-id'];
  errorContext.root = root;
  if (['fail', 'cancel'].includes(action) && !opts.reason?.trim()) throw new Error('A native subagent failure reason is required');
  if (!['fail', 'cancel'].includes(action) && opts.reason) throw new Error('Failure reason applies only to fail');
  if (['bind', 'receive', 'draft-ready', 'bind-writer', 'write-documents'].includes(action) !== Boolean(opts['agent-id'])) throw new Error('Native agent ID is required only for bind, receive, draft-ready, bind-writer and write-documents');
  if (opts['repair-binding'] && (action !== 'bind' || opts['repair-binding'] !== 'true')) throw new Error('--repair-binding true is only valid with bind');
  const session = await cliSession(root, opts['worktree-ref']);
  const input = await readExecutionInput({ root, execution_id: id });
  await validateSkillInput({ root, input });
  if (input.skill === 'spec-me' || input.context?.stage_id === 'spec-me') throw new Error('spec-me has been removed; continue from context-boundary with tactical-to-code');
  if (input.session_directory !== session || input.context?.worktree_ref !== opts['worktree-ref'] || input.context?.parent_execution_id || input.skill === 'workflow-compose') throw new Error('Invalid native stage workspace or input');
  errorContext.stageId = input.context?.stage_id || input.skill;
  const { workflow, stage } = await resolveWorkflowStage({ root, input });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage, workflowBinding: input.context?.workflow_binding || null, executionProvider: input.context?.provider || null, requestedStageBinding: input.context?.requested_stage_binding });
  if ((input.context?.provider && input.context.provider !== binding.provider) || (input.context?.orchestrator_provider && input.context.orchestrator_provider !== binding.provider) || (input.context?.resume_provider && input.context.resume_provider !== binding.provider)) throw new Error('Execution provider must match the orchestrator and binding');
  const paths = stageExecutionPaths(root, id);
  const planSetId = input.context?.plan_set_id || commandContext.plan_set_id;
  if (action === 'start') {
    // An input prepared before the flow was complete (or by an older Harness) still cannot start a stage out of order.
    const flow = await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const orderViolation = flow ? preSpecOrderViolation((flow.state || flow).stages, input.context?.stage_id || input.skill) : null;
    if (orderViolation) throw new Error(orderViolation);
    const tacticalViolation = flow ? tacticalImplementationOrderViolation((flow.state || flow).stages, input.context?.stage_id || input.skill) : null;
    if (tacticalViolation) throw new Error(tacticalViolation);
    if (flow) {
      const { assertFrontendTicketOrder } = await import('../../.harness/src/workflow/stage-input.mjs');
      await assertFrontendTicketOrder({ root, session, state: flow.state || flow, stageId: input.context?.stage_id || input.skill, planSetId: input.context?.plan_set_id, planId: input.context?.plan_id });
    }
    await writeOutputSchema({ root, input, prefix: `runtime/executions/${id}`, path: paths.files.schema, provider: binding.provider });
    const guide = [`.harness/internal-skills/${input.skill}/GUIDE.md`, `.codex/skills/${input.skill}/SKILL.md`, `.claude/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
    if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
    const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
    const documentDraft = stageDocumentPolicy(input.skill, planSetId) ? await prepareStageDocumentDrafts(root, id) : null;
    // A browser stage checks its role's network, a Chromium launch and (for real zoom) a headed display before any worker
    // exists; a failure is ENVIRONMENT_UNAVAILABLE with each fix and leaves the prepared execution unstarted.
    const { prepareStageBrowserEnvironment, releaseStageBrowserEnvironment } = await import('../../.harness/src/workflow/browser-environment.mjs');
    const browserEnvironment = await prepareStageBrowserEnvironment({ root, input, profile: profile || 'workflow_stage', provider: binding.provider, executionDirectory: paths.directory, startCommand: nativeCommand('start', id) });
    try { await recordExecutionState({ root, input, binding, status: 'running', nativeClaim: true }); }
    catch (error) { if (browserEnvironment) await releaseStageBrowserEnvironment(paths.directory); throw error; }
    const started = { execution_id: id, workspace: root, input_path: await executionInputAbsolutePath(root, id), guide: join(root, guide), schema_path: paths.files.schema, output_path: paths.files.raw, agent_profile: profile || 'workflow_stage', sandbox, binding,
      ...(documentDraft ? { document_draft_root: documentDraft } : {}),
      ...(existsSync(paths.files.answers) ? { answers_path: paths.files.answers } : {}),
      ...(browserEnvironment ? { browser_environment_path: browserEnvironment.path } : {}),
      ...(existsSync(paths.files.feedback) ? { feedback_path: paths.files.feedback } : {}),
    };
    process.stdout.write(`${JSON.stringify(verbose ? started : compactStarted(started, { executionId: id }))}\n`);
  } else {
    const state = await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' });
    const current = (state.state || state).stages?.[input.context?.stage_id || input.skill];
    if (current?.status !== 'running' || current.execution_id !== id || !current.native_managed) throw new Error('Native stage is not running for this execution');
    if (action === 'draft-ready') {
      if (!reviewedDocuments(input.skill) || opts['agent-id'] !== current.native_agent_id || existsSync(paths.files.raw)) throw new Error('Only the bound plan or contract stage worker can request a writer before submitting its result');
      const proposal = { root, input, envelope: {}, planSetId, binding, beforeReview: true };
      let batch;
      try { batch = await stageDocumentBatch(proposal); }
      catch (error) {
        if (!/changed after their writer batch/.test(error.message)) throw error;
        const pending = await readWriterBatch(root, id);
        const { inspectReviewHistory } = await import('../../.harness/src/workflow/review-attempts.mjs');
        const history = await inspectReviewHistory({ root, scope: reviewScope(input.skill, planSetId) });
        if (history.recorded_state === 'active' || history.last_native_review?.execution_id === id && history.recorded_state === 'pass') throw error;
        const reviewed = await finishedWriterBatch(root, pending);
        if (!reviewed) throw error;
        await assertStageDocumentWriterCompleted(root, reviewed);
        await archiveWriterComposition(root, pending);
        batch = await stageDocumentBatch(proposal);
      }
      const composed = batch ? await finishedWriterBatch(root, batch) : null;
      if (batch && !composed) await printWriterPending(root, batch);
      else {
        if (composed) await assertStageDocumentWriterCompleted(root, composed);
        process.stdout.write(`${JSON.stringify({ status: 'review_ready', execution_id: id })}\n`);
      }
      process.exit(0);
    }
    if (['bind-writer', 'write-documents'].includes(action)) {
      if (!current.native_agent_id) throw new Error('Native stage must have a bound worker before assigning a writer');
      const agentId = opts['agent-id'];
      let writerStep;
      if (action === 'bind-writer') {
        const batch = await readWriterBatch(root, id);
        let parentSessionId = (state.state || state).orchestrator_session_id;
        let parentAgentPath;
        if (batch.phase === 'review' && binding.provider === 'codex') {
          const { codexDocumentWriterParent } = await import('../../.harness/src/workflow/native-context.mjs');
          const owner = await codexDocumentWriterParent({ root, sessionId: parentSessionId, stageAgentId: current.native_agent_id });
          parentSessionId = owner.sessionId;
          parentAgentPath = owner.agentPath;
        }
        const assignment = await bindStageDocumentWriter({ root, id, agentId, workerId: current.native_agent_id, parentSessionId, parentAgentPath });
        const brief = await prepareWriterBrief(root, batch);
        writerStep = { status: 'writer_bound', ...assignment, ...(brief ? { writer_brief_path: brief } : {}), write_command: nativeCommand('write-documents', id, `--agent-id '${agentId}'`) };
      } else {
        const threadId = await authenticateWriterCommand({ root, id, agentId });
        const composition = await receiveWriterComposition({ root, id, agentId, threadId });
        writerStep = { status: 'documents_composed', execution_id: id, documents: composition.entries.length };
      }
      process.stdout.write(`${JSON.stringify(writerStep)}\n`);
      process.exit(0);
    }
    if (action === 'inspect') {
      let observation = null;
      let codexOutcome = null;
      let modelAttestation = null;
      const workflowState = state.state || state;
      if (binding.provider === 'codex' && current.native_agent_id) {
        const { resolveNativeCodexThread, readNativeCodexOutcome, readNativeCodexAttestation } = await import('../../.harness/src/workflow/native-context.mjs');
        const target = { root, parentSessionId: workflowState.orchestrator_session_id, stage: { ...current, stage_id: input.context?.stage_id || input.skill } };
        const threadId = await resolveNativeCodexThread(target);
        if (threadId) codexOutcome = { thread_id: threadId, outcome: await readNativeCodexOutcome(target, threadId).catch(() => null) };
        if (input.context?.requested_stage_binding) {
          modelAttestation = await readNativeCodexAttestation(target);
          // The hook-time record is written before the worker's task_complete exists; read the finished transcript now.
          if (modelAttestation.status === 'unavailable' && ['completed_turn_metadata_missing', 'attestation_not_recorded', 'transcript_unavailable'].includes(modelAttestation.reason) && codexOutcome?.outcome?.status === 'completed') {
            const { refreshNativeCodexAttestation } = await import('../../.harness/src/workflow/native-context.mjs');
            modelAttestation = await refreshNativeCodexAttestation(target);
          }
        }
      }
      const threadId = codexOutcome?.thread_id || null;
      const relative = `runtime/executions/${id}/native-observations.jsonl`;
      await assertWorkspaceTarget(session, relative);
      let file;
      try {
        file = await open(join(session, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw new Error('Unsafe native observation log');
        const lines = (await file.readFile('utf8')).trim().split('\n').filter(Boolean);
        const parent = (state.state || state).orchestrator_session_id;
        for (const line of lines) {
          const entry = JSON.parse(line);
          const matchingSession = entry.session_id === parent || threadId && entry.session_id === threadId && entry.agent_id === threadId;
          if (matchingSession && [current.native_agent_id, `/root/${current.native_agent_id}`, threadId].filter(Boolean).includes(entry.agent_id) && ['SubagentStart', 'SubagentStop'].includes(entry.event)) observation = entry;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { if (file) await file.close(); }
      // Which conversation owns the run, what the agent's own transcript says, and the next step when another (ended)
      // conversation started it: this one cannot wait for or finish an agent it did not spawn, so it takes the stage over.
      const here = process.env.CODEX_THREAD_ID || null;
      const nativeOutcome = codexOutcome?.outcome?.status || null;
      const foreign = foreignRunningStage(workflowState, here);
      const finishable = foreign && nativeOutcome === 'completed' && existsSync(paths.files.raw) && statSync(paths.files.raw).size > 0;
      const next = finishable ? `Its agent completed and wrote its output; record it: ${nativeCommand('finish', id)}` : foreign ? takeoverStep(foreign) : null;
      process.stdout.write(`${JSON.stringify({ status: current.status, execution_id: id, agent_id: current.native_agent_id || null, thread_id: threadId, observation, ...(nativeOutcome ? { native_outcome: nativeOutcome } : {}), ...(input.context?.requested_stage_binding ? { requested_binding: input.context.requested_stage_binding, model_attestation: modelAttestation, ...(modelAttestation?.status === 'captured' ? { observed_bindings: modelAttestation.turns.map(({ model, reasoning_effort, turn_id }) => ({ model, reasoning_effort, turn_id })) } : {}) } : {}), ...(here && workflowState.orchestrator_session_id ? { session: workflowState.orchestrator_session_id === here ? 'this' : 'other' } : {}), output_path: paths.files.raw, schema_path: paths.files.schema, ...(current.native_agent_id ? { receive_command: nativeReceiveCommand(id, current.native_agent_id) } : {}), ...(next ? { next } : {}) })}\n`);
      process.exit(0);
    }
    if (action === 'bind') {
      const agentId = opts['agent-id'];
      let verifiedRebind = null;
      if (opts['repair-binding'] === 'true') {
        if (binding.provider !== 'codex' || !input.context?.orchestrator_session_id || !input.context?.requested_stage_binding || !current.native_agent_id || current.native_agent_id === agentId) throw new Error('Native binding repair requires a differently bound Codex stage with a requested model binding');
        const { verifyNativeCodexWorkerBinding } = await import('../../.harness/src/workflow/native-context.mjs');
        const verify = (nativeAgentId) => verifyNativeCodexWorkerBinding({ root, parentSessionId: input.context.orchestrator_session_id, stage: current, nativeAgentId, requestedBinding: binding });
        const previous = await verify(current.native_agent_id);
        if (previous.status === 'verified') throw new Error('Existing native binding is valid; refusing replacement');
        verifiedRebind = await verify(agentId);
        if (verifiedRebind.status !== 'verified') throw new Error(`Replacement native binding is not verified: ${verifiedRebind.reason || verifiedRebind.status}`);
      }
      await recordExecutionState({ root, input, binding, status: 'running', nativeAgentId: agentId, nativeAgentRebindVerified: Boolean(verifiedRebind) });
      if (verifiedRebind) {
        const relative = `runtime/executions/${id}/native-binding-repairs.jsonl`;
        await assertWorkspaceTarget(session, relative);
        const file = await open(join(session, 'runtime/executions', id, 'native-binding-repairs.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Unsafe native binding repair log');
          await file.writeFile(`${JSON.stringify({ schema_version: 1, execution_id: id, stage_id: input.context?.stage_id || input.skill, parent_session_id: input.context.orchestrator_session_id, previous_agent_id: current.native_agent_id, repaired_agent_id: verifiedRebind.agent_id, child_thread_id: verifiedRebind.thread_id, verified_turns: verifiedRebind.turns.map(({ turn_id, model, reasoning_effort, status }) => ({ turn_id, model, reasoning_effort, status })), verified_at: new Date().toISOString() })}\n`);
        } finally { await file.close(); }
      }
      process.stdout.write(`${JSON.stringify({ status: 'running', execution_id: id, agent_id: agentId, receive_command: nativeReceiveCommand(id, agentId) })}\n`);
      process.exit(0);
    }
    if (action === 'recover-interrupted') {
      if (binding.provider !== 'codex' || !input.context?.orchestrator_session_id || process.env.CODEX_THREAD_ID !== input.context.orchestrator_session_id) throw new Error('Recovery requires the original Codex parent session');
      const { readNativeCodexOutcome } = await import('../../.harness/src/workflow/native-context.mjs');
      const outcome = await readNativeCodexOutcome({ root, parentSessionId: input.context.orchestrator_session_id, stage: current });
      if (outcome?.status !== 'interrupted' || existsSync(paths.files.raw)) {
        process.stdout.write(`${JSON.stringify({ status: 'unchanged', execution_id: id })}\n`);
        process.exit(0);
      }
      action = 'fail';
      opts.reason = 'Native agent was interrupted by the host';
    }
    if (action === 'reconcile') {
      if (binding.provider !== 'codex' || !input.context?.orchestrator_session_id || process.env.CODEX_THREAD_ID !== input.context.orchestrator_session_id) throw new Error('Reconciliation requires the original Codex parent session');
      if (!current.native_agent_id) throw new Error('Native subagent binding is unavailable');
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Native agent status exceeds size limit'); }
      let report;
      try { report = JSON.parse(text); } catch { throw new Error('Native agent status must be a JSON object from the current host'); }
      if (!report || !Array.isArray(report.agents)) throw new Error('Native agent status must contain the current host agent list');
      const expected = current.native_agent_id.startsWith('/') ? current.native_agent_id : `/root/${current.native_agent_id}`;
      const matches = report.agents.filter((item) => item?.agent_name === expected);
      if (matches.length === 1 && ['running', 'pending'].includes(matches[0].agent_status)) {
        process.stdout.write(`${JSON.stringify({ status: 'running', execution_id: id, agent_id: current.native_agent_id })}\n`);
        process.exit(0);
      }
      const { readNativeCodexOutcome } = await import('../../.harness/src/workflow/native-context.mjs');
      const outcome = await readNativeCodexOutcome({ root, parentSessionId: input.context.orchestrator_session_id, stage: current });
      if (matches.length !== 1 && !(matches.length === 0 && outcome?.status === 'interrupted')) {
        process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'agent_not_uniquely_reported' })}\n`);
        process.exit(0);
      }
      const hostStatus = matches.length ? matches[0].agent_status : 'interrupted';
      if (hostStatus && typeof hostStatus === 'object' && !Array.isArray(hostStatus) && Object.keys(hostStatus).length === 1 && Object.hasOwn(hostStatus, 'completed') && typeof hostStatus.completed === 'string') {
        if (outcome?.status !== 'completed' || outcome.output !== hostStatus.completed) {
          process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'completed_turn_not_verified' })}\n`);
          process.exit(0);
        }
        action = 'finish';
        const reviewBatch = ['to-ticket', 'sync-contracts'].includes(input.skill) && await readWriterBatch(root, id, { required: false });
        if (!existsSync(paths.files.raw) && hostStatus.completed.trim() && reviewBatch?.phase !== 'review') {
          await assertWorkspaceTarget(session, paths.refs.raw);
          const file = await open(paths.files.raw, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(hostStatus.completed); } finally { await file.close(); }
        }
      } else if (hostStatus === 'interrupted' || hostStatus && typeof hostStatus === 'object' && !Array.isArray(hostStatus) && Object.keys(hostStatus).length === 1 && (typeof hostStatus.failed === 'string' || typeof hostStatus.error === 'string')) {
        if (outcome?.status !== (hostStatus === 'interrupted' ? 'interrupted' : 'failed')) {
          process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'failed_turn_not_verified' })}\n`);
          process.exit(0);
        }
        action = 'fail';
        opts.reason = hostStatus === 'interrupted' ? 'Native agent was interrupted by the host' : outcome.error.slice(0, 4000);
        if (!opts.reason.trim()) throw new Error('Native agent failure reason is empty');
      } else {
        process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'unrecognized_host_status' })}\n`);
        process.exit(0);
      }
    }
    if (action === 'fail' || action === 'cancel') {
      await rollbackStageDocumentWrite(root, id, { includeWritten: true });
      const status = action === 'cancel' ? 'cancelled' : 'failed';
      const code = status === 'cancelled' ? 'CANCELLED' : 'EXECUTION_ERROR';
      const beforeTransition = input.skill === 'implement-wrapper' && input.context?.plan_id
        ? () => writeImplementationCheckpoint({ input, status, code, verified: false, reason: opts.reason }) : null;
      try { await recordExecutionState({ root, input, binding, status, code, reason: opts.reason, nativeTerminalAgentId: current.native_agent_id || null, beforeTransition }); }
      catch (error) {
        if (!error.checkpointFailure) throw error;
        await recordExecutionState({ root, input, binding, status: 'failed', code: 'EXECUTION_ERROR', reason: error.message, nativeTerminalAgentId: current.native_agent_id || null });
        throw error;
      }
      await (await import('../../.harness/src/workflow/browser-environment.mjs')).releaseStageBrowserEnvironment(paths.directory);
      process.stdout.write(`${JSON.stringify({ status, execution_id: id, reason: opts.reason })}\n`);
      process.exit(0);
    }
    if (!current.native_agent_id) throw new Error('Native stage must be bound to the actual subagent ID');
    if (action === 'receive') {
      if (current.native_agent_id !== opts['agent-id']) throw new Error('Native subagent binding mismatch');
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Native output exceeds size limit'); }
      let source = null;
      if (!text.trim()) {
        // The worker's final JSON belongs on standard input. The orchestrator conversation that ran this bare command may
        // instead take it from the bound Codex worker's own transcript; nothing else can stand in for the worker's output.
        const parent = (state.state || state).orchestrator_session_id;
        if (binding.provider !== 'codex' || !parent || process.env.CODEX_THREAD_ID !== parent) throw new Error('Native subagent output is empty');
        const { readNativeCodexSubmission } = await import('../../.harness/src/workflow/native-context.mjs');
        const stageId = input.context?.stage_id || input.skill;
        const submission = await readNativeCodexSubmission({ root, parentSessionId: parent, stage: { ...current, stage_id: stageId } });
        const details = { executionId: id, stageId, agentId: current.native_agent_id };
        if (submission.status === 'completed') { text = submission.output; source = { source: 'native_transcript', thread_id: submission.thread_id }; }
        else if (submission.status === 'completed_without_json' && existsSync(paths.files.raw)) {
          process.stdout.write(`${JSON.stringify({ status: 'already_received', execution_id: id, thread_id: submission.thread_id, next: nativeCommand('finish', id) })}\n`);
          process.exit(0);
        }
        else if (submission.status === 'unavailable') throw new Error('Native subagent output is empty');
        else {
          const kind = { running: 'running', failed: 'failed', interrupted: 'interrupted' }[submission.status] || 'empty';
          throw Object.assign(new Error('Native subagent output is empty'), { explained: receiveRecoveryError(kind, { ...details, detail: submission.error || (submission.reason || '').replaceAll('_', ' ') }) });
        }
      }
      await assertWorkspaceTarget(session, paths.refs.raw);
      const file = await open(paths.files.raw, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error('Native output must be a regular unshared file');
        await file.truncate(0);
        await file.writeFile(text);
      } finally { await file.close(); }
      process.stdout.write(`${JSON.stringify({ status: 'received', execution_id: id, ...(source || {}) })}\n`);
      process.exit(0);
    }
    const preparingReview = reviewedDocuments(input.skill) && !existsSync(paths.files.raw);
    if (preparingReview && binding.provider === 'claude-code' && await printClaudeReviewHandoff({ root, input, planSetId, current })) process.exit(0);
    const reviewWriter = preparingReview ? await readWriterBatch(root, id, { required: false }) : null;
    if (reviewWriter?.phase === 'review') {
      const written = await finishedWriterBatch(root, reviewWriter);
      if (!written) await printWriterPending(root, reviewWriter);
      else {
        await assertStageDocumentWriterCompleted(root, written);
        process.stdout.write(`${JSON.stringify({ status: 'review_ready', execution_id: id, agent_id: current.native_agent_id, document_composition_root: join(paths.directory, 'document-drafts/composition/workspace'), next: nativeCommand('finish', id) })}\n`);
      }
      process.exit(0);
    }
    // No output file: the bound worker has not submitted. Say so before any check that needs its finished turn.
    if (!existsSync(paths.files.raw)) {
      process.stdout.write(`${JSON.stringify(outputMissingResult({ executionId: id, agentId: current.native_agent_id, errors: [{ path: '$', rule: 'required', expected: 'output file', value: null, missing: true }], schemaPath: paths.files.schema, outputPath: paths.files.raw }))}\n`);
      process.exit(1);
    }
    if (binding.provider === 'codex' && input.context?.requested_stage_binding) {
      const { refreshNativeCodexAttestation } = await import('../../.harness/src/workflow/native-context.mjs');
      const target = { root, parentSessionId: input.context.orchestrator_session_id, stage: { ...current, stage_id: input.context?.stage_id || input.skill } };
      const observed = await refreshNativeCodexAttestation(target);
      if (observed.status !== 'captured') throw new Error(`Requested stage binding cannot be verified: native attestation ${observed.reason || observed.status}`);
      const mismatches = observed.turns.filter((turn) => turn.status !== 'completed' || turn.model !== binding.model || turn.reasoning_effort !== binding.reasoning_effort);
      if (!observed.turns.length || mismatches.length) {
        const actual = observed.turns.map((turn) => `${turn.model || 'unknown'}/${turn.reasoning_effort || 'unknown'} (${turn.status})`).join(', ') || 'no completed turn metadata';
        throw new Error(`Requested stage binding mismatch: expected ${binding.model}/${binding.reasoning_effort}, observed ${actual}`);
      }
    }
    const schema = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.schema });
    let format, raw;
    try { raw = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.raw }); format = validateOutputFormat(raw, schema); }
    catch (error) {
      if (error.code === 'ENOENT') format = { valid: false, errors: [{ path: '$', rule: 'required', expected: 'output file', value: null, missing: true }] };
      else if (error instanceof SyntaxError) format = { valid: false, errors: [{ path: '$', rule: 'json', expected: 'valid JSON', value: null, message: error.message }] };
      else throw error;
    }
    const formatDetails = { executionId: id, agentId: current.native_agent_id, schemaPath: paths.files.schema, outputPath: paths.files.raw, verbose };
    if (!format.valid) { process.stdout.write(`${JSON.stringify(formatErrorResult({ ...formatDetails, errors: format.errors }))}\n`); process.exit(1); }
    // Codex runs the SubagentStop hook before it appends the worker's task_complete, so the hook-time attestation of every
    // finished worker lacks its completed turn. The submitted worker has ended by now: record the completed turn from its
    // transcript (an execution with a requested model and effort did this above and blocks on a mismatch; the others only
    // gain telemetry, so a failure here never stops the stage).
    if (binding.provider === 'codex' && !input.context?.requested_stage_binding && input.context?.orchestrator_session_id) {
      const { refreshNativeCodexAttestation } = await import('../../.harness/src/workflow/native-context.mjs');
      await refreshNativeCodexAttestation({ root, parentSessionId: input.context.orchestrator_session_id, stage: { ...current, stage_id: input.context?.stage_id || input.skill } }).catch(() => null);
    }
    // A blocked / DEPENDENCY_INCOMPLETE result of a later flow stage must name the earlier stage that owns the gap, so the
    // orchestrator can reopen it by itself. The stage stays running and the subagent corrects its output.
    const { dependencyOwnerErrors, staleStages } = await import('../../.harness/src/workflow/stage-reopen.mjs');
    const ownerErrors = dependencyOwnerErrors({ skill: input.skill, raw });
    if (ownerErrors) { process.stdout.write(`${JSON.stringify(formatErrorResult({ ...formatDetails, errors: ownerErrors }))}\n`); process.exit(1); }
    const { assertTacticalRequirementsReadOnly, commitStageRequest, commitWorkflowDocuments } = await import('../../.harness/src/workflow/stage-commit.mjs');
    await assertTacticalRequirementsReadOnly(root, input);
    // A worker that authored its own documents has no writer receipt: undo an interrupted publication before re-planning it.
    if (authorsOwnDocuments(input.skill)) await rollbackStageDocumentWrite(root, id);
    const batch = await stageDocumentBatch({ root, input, envelope: raw, planSetId, binding, workerId: current.native_agent_id, allowInline: Boolean(schema.properties.result.properties.artifact_contents) });
    const writtenBatch = batch ? await finishedWriterBatch(root, batch) : null;
    if (batch && !writtenBatch) {
      await printWriterPending(root, batch);
      process.exit(0);
    }
    if (writtenBatch) await assertStageDocumentWriterCompleted(root, writtenBatch);
    const rejectDraft = async (details) => {
      if (writtenBatch && writtenBatch.mode !== 'author') {
        // Reviewer staleness requires a new independent attempt against the same composed bytes.
        // Other failed document gates allow the worker to revise its brief.
        if (details.gate !== 'document_review_check') await archiveWriterComposition(root, writtenBatch);
        await archiveRejectedSubmission(root, paths, id);
      }
      await printGateError({ session, paths, executionId: id, ...details });
      process.exit(1);
    };
    // stakeholder-analysis is accepted (its questions or its completion) only when the requester's features are recorded as settled
    // and no anchored persona candidate was dropped as out of scope. A rejection leaves the stage running for the same subagent.
    const { evaluateStakeholderAnalysisGate, stakeholderAnalysisFailureInstruction } = await import('../../.harness/src/workflow/stakeholder-analysis-gate.mjs');
    const analysisGate = await evaluateStakeholderAnalysisGate({ root, input, envelope: raw, draftExecutionId: id });
    if (analysisGate && !analysisGate.ok) {
      await rejectDraft({ gate: 'stakeholder_analysis_check', stage: analysisGate.stage, errors: analysisGate.errors, instruction: stakeholderAnalysisFailureInstruction(analysisGate) });
    }
    // Check BIZ field shape and, at requirements completion, the rule, exception and acceptance entries.
    const { evaluateRequirementsDocumentGate, requirementsDocumentFailureInstruction } = await import('../../.harness/src/workflow/requirements-document-gate.mjs');
    const documentGate = await evaluateRequirementsDocumentGate({ root, input, envelope: raw, draftExecutionId: id });
    if (documentGate && !documentGate.ok) {
      await rejectDraft({ gate: 'requirements_document_check', stage: documentGate.stage, errors: documentGate.errors, instruction: requirementsDocumentFailureInstruction(documentGate) });
    }
    // Check component ownership at each stage and the whole design at context-boundary before committing anything.
    const { evaluateTacticalDesignGate, gateFailureInstruction } = await import('../../.harness/src/workflow/domain-model-gate.mjs');
    const gate = await evaluateTacticalDesignGate({ root, input, envelope: raw, draftExecutionId: id });
    if (gate && !gate.ok) {
      await rejectDraft({ gate: 'domain_model_check', stage: gate.stage, errors: gate.errors, instruction: gateFailureInstruction(gate) });
    }
    // The last implementation-design stage (tactical-data) is accepted as completed only when the design freezes: nothing in api.md,
    // data.md or ui-handoff.md adds scope, and every requirement is covered. A rejection leaves the stage running; an error of an
    // earlier stage's document makes the stage return blocked / DEPENDENCY_INCOMPLETE naming that owner.
    const { evaluateDesignFreezeGate, freezeFailureInstruction } = await import('../../.harness/src/workflow/design-freeze-gate.mjs');
    const freeze = await evaluateDesignFreezeGate({ root, input, envelope: raw, draftExecutionId: id });
    if (freeze && !freeze.ok) {
      await rejectDraft({ gate: 'design_freeze_check', stage: freeze.stage, errors: freeze.errors, instruction: freezeFailureInstruction(freeze) });
    }
    if (!writtenBatch && binding.provider === 'claude-code' && input.context?.plan_set_id && reviewedDocuments(input.skill)) {
      const { assertNoUnrecordedNativeReview } = await import('../../.harness/src/workflow/review-attempts.mjs');
      const prefix = input.skill === 'to-ticket' ? 'plan' : 'contracts';
      const scope = `${prefix}-${input.context.plan_set_id}`;
      await assertNoUnrecordedNativeReview({ root, scope });
    }
    if (writtenBatch && raw.status === 'completed' && reviewedDocuments(input.skill)) {
      const { assertNoRogueReviewer } = await import('../../.harness/src/workflow/stage-runtime.mjs');
      let review;
      try {
        await assertNoRogueReviewer({ root, session, input });
        if (binding.provider === 'claude-code') await (await import('../../.harness/src/workflow/review-attempts.mjs')).assertNoUnrecordedNativeReview({ root, scope: reviewScope(input.skill, planSetId) });
        review = input.skill === 'to-ticket'
          ? await (await import('../../.harness/src/workflow/plan-review.mjs')).inspectPlanSet({ root, planSetId, phase: 'planning', executionId: id })
          : await (await import('../../.harness/src/workflow/contract-review.mjs')).inspectContractReview({ root, planSetId, executionId: id });
      } catch (error) { review = { status: 'blocked', reason: 'REVIEW_REQUIRED', details: { problem: error.message } }; }
      if (review.status !== 'pass') await rejectDraft({ gate: 'document_review_check', stage: input.skill, errors: [{ code: review.reason || 'REVIEW_REQUIRED', message: review.details?.problem || 'The authored document batch has no current passing native review' }], instruction: 'Return the review result to the owning stage. The submitted output was archived and the composed documents are preserved. Finish the independent review against the current draft before resubmitting.' });
    }
    const { applyDomainSync, assertStageDomainSync, prepareStageDomainSync } = await import('../../.harness/src/domain/sync.mjs');
    const domainPlan = raw.status === 'completed' && raw.code === 'OK'
      ? await prepareStageDomainSync(root, input, writtenBatch ? id : null) : null;
    if (writtenBatch?.mode === 'author') await persistAuthoredBatch(root, writtenBatch);
    if (writtenBatch) await writeStageDocumentBatch({ root, batch: writtenBatch, planSetId, skill: input.skill });
    await commitStageRequest({ root, rawPath: paths.files.raw });
    const resultCommand = [process.execPath, join(root, '.harness/scripts/harness-result.mjs'), '--root', root, '--worktree-ref', opts['worktree-ref'], '--execution-id', id, '--source', paths.refs.raw];
    const resultCommandRun = runStageCommand(resultCommand, { cwd: root });
    const resultCommandDirectory = `runtime/executions/${id}/result-command-attempts/${randomUUID()}`;
    let resultCommandMetadata = resultCommandRun.metadata, evidenceError;
    try { resultCommandMetadata = await saveStageCommand(root, resultCommandDirectory, resultCommandRun); }
    catch (error) { evidenceError = error.code || error.message; }
    const { exit_code: exitCode, signal, spawn_error: spawnError } = resultCommandMetadata;
    if (spawnError || exitCode !== 0) {
      if (writtenBatch) await rollbackStageDocumentWrite(root, id, { includeWritten: true });
      const childJsonError = lastJson(resultCommandRun.stderr)?.error;
      const childDetail = childJsonError || String(resultCommandRun.stderr.subarray(-1024)).trim()
        || (spawnError ? `${spawnError.name}: ${spawnError.message}` : null)
        || (signal ? `child terminated by signal ${signal}` : `child exited with status ${exitCode}`);
      const message = `Result rejected: ${childDetail}`;
      throw Object.assign(new Error(message), { explained: {
        error: message,
        code: 'RESULT_REJECTED',
        why: `The output passed the schema, but harness-result exited unsuccessfully (status ${exitCode ?? 'unknown'}${signal ? `, signal ${signal}` : ''}). ${evidenceError ? 'Writing the child evidence failed.' : `Raw child output and process metadata were preserved in ${resultCommandDirectory}.`} The workflow stage is still running.`,
        next: [...(evidenceError ? [] : [`Review ${resultCommandMetadata.process_path}, stdout.log and stderr.log before retrying.`]), `After addressing the recorded child failure, run: ${nativeCommand('finish', id)}`],
        result_command: { ...resultCommandMetadata, error: spawnError?.message || null, ...(evidenceError ? { evidence_error: evidenceError } : {}) },
      } });
    }
    if (domainPlan) {
      await applyDomainSync(root, domainPlan, { commit: (domainPaths) => commitWorkflowDocuments({ root, input, rawPath: paths.files.raw, domainPaths }) });
    } else {
      if (raw.status === 'completed' && raw.code === 'OK') await assertStageDomainSync(root, input);
      await commitWorkflowDocuments({ root, input, rawPath: paths.files.raw });
    }
    const envelope = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.returned });
    const beforeTransition = input.skill === 'implement-wrapper' && input.context?.plan_id
      ? () => writeImplementationCheckpoint({ input, status: envelope.status, code: envelope.code, envelope, verified: true }) : null;
    try { await recordExecutionState({ root, input, binding, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref, nativeTerminalAgentId: current.native_agent_id || null, beforeTransition }); }
    catch (error) {
      if (!error.checkpointFailure) throw error;
      await recordExecutionState({ root, input, binding, status: 'failed', code: 'EXECUTION_ERROR', reason: error.message, nativeTerminalAgentId: current.native_agent_id || null });
      throw error;
    }
    const updated = envelope.status === 'completed' ? await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' }).catch(() => null) : null;
    const staleOrder = updated ? staleStages(updated.state || updated) : null;
    const requirementsPresent = input.skill !== 'bounded-context' || Boolean(input.context?.plan_set_id && (await (await import('../../.harness/src/workflow/domain-model-gate.mjs')).planSetDocument(root, input.context.plan_set_id, 'requirements.md')).text !== null);
    await (await import('../../.harness/src/workflow/browser-environment.mjs')).releaseStageBrowserEnvironment(paths.directory);
    const finished = compactFinished({ envelope, stageId: errorContext.stageId, executionId: id, staleOrder, requirementsPresent, session, provider: binding.provider });
    process.stdout.write(`${JSON.stringify(verbose ? { status: envelope.status, code: envelope.code, result_ref: envelope.result_ref, result: envelope.result, ...(staleOrder?.length ? { stale_stages: staleOrder } : {}) } : finished)}\n`);
  }
} catch (error) { writeError(process.stderr, error, errorContext); process.exitCode = 2; }
