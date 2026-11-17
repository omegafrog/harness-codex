#!/usr/bin/env node
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { assertWorkspaceTarget } from '../../.harness/src/eval/case-workspace.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliSession } from '../../.harness/src/workflow/cli-session.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { executionInputAbsolutePath } from '../../.harness/src/workflow/execution-input.mjs';
import { recordExecutionState } from '../../.harness/src/workflow/execution-state.mjs';
import { readExecutionInput, readSkillSessionJson, resolveAgentSandbox, resolveSkillBinding, resolveWorkflowStage, validateSkillInput } from '../../.harness/src/workflow/skill-execution.mjs';
import { stageExecutionPaths } from '../../.harness/src/workflow/session-output.mjs';
import { validateOutputFormat, writeOutputSchema } from '../../.harness/src/workflow/output-schema.mjs';
import { writeImplementationCheckpoint } from '../../.harness/src/workflow/stage-checkpoint.mjs';
import { preSpecOrderViolation, tacticalImplementationOrderViolation } from '../../.harness/src/workflow/worktree-stages.mjs';
import { TAKEOVER_FEEDBACK, compactFinished, compactStarted, extractVerbose, foreignRunningStage, formatErrorResult, gateErrorResult, launchResult, compactPrepared, nativeCommand, takeoverStep, writeError } from '../../.harness/src/workflow/stage-cli.mjs';

// What the error output needs to know about this call.
const errorContext = { script: 'native-stage', action: undefined, executionId: undefined, stageId: undefined, root: undefined };

const lastJson = (text) => { try { return JSON.parse(String(text || '').trim().split('\n').filter(Boolean).pop()); } catch { return null; } };
// A failed child command already printed its explanation as one JSON object: pass it on instead of wrapping it.
const childFailure = (child, context = {}) => {
  const printed = lastJson(child.stderr);
  const error = new Error(printed?.error || String(child.stderr || '').trim() || 'The command failed');
  if (printed?.code && printed.why) error.explained = { ...printed, ...context };
  return error;
};

// `--take-over true` is the only option besides --stage-id: it returns the stage's id, or null without the flag.
function takeOverStage(args) {
  const index = args.indexOf('--take-over');
  if (index < 0) return null;
  const rest = args.filter((_, i) => i !== index && i !== index + 1);
  if (args[index + 1] !== 'true' || rest.length !== 2 || rest[0] !== '--stage-id' || !rest[1]) throw new Error('Taking over an interrupted stage must be requested alone');
  return rest[1];
}

// prepare + start in one call: the orchestrator gets exactly what it needs to spawn the subagent and then bind it.
// With --take-over true the stage another (ended) Codex conversation left running is first recorded as interrupted and
// this conversation becomes the orchestrator; the launch then resumes that stage with a fresh execution.
function launchStage(requestedArgs, verbose) {
  const scripts = fileURLToPath(new URL('.', import.meta.url));
  const run = (script, scriptArgs) => spawnSync(process.execPath, [join(scripts, script), ...scriptArgs], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const takeOverId = takeOverStage(requestedArgs);
  let args = requestedArgs, taken = null;
  if (takeOverId) {
    errorContext.stageId = takeOverId;
    const takeover = run('harness-prepare-input.mjs', ['--stage-id', takeOverId, '--take-over-interrupted', 'true']);
    if (takeover.status !== 0) throw childFailure(takeover);
    taken = lastJson(takeover.stdout);
    if (!taken) throw new Error('harness-prepare-input.mjs printed no result');
    args = ['--stage-id', takeOverId, '--feedback', TAKEOVER_FEEDBACK];
  }
  const prepare = run('harness-prepare-input.mjs', [...args, '--verbose']);
  if (prepare.status !== 0) throw childFailure(prepare);
  const prepared = lastJson(prepare.stdout);
  if (!prepared) throw new Error('harness-prepare-input.mjs printed no result');
  // A saved answer, a partial answer batch or a restart/discard does not start a stage: show what prepare reports.
  if (!prepared.input?.execution_id) return verbose ? prepared : compactPrepared(prepared);
  const id = prepared.input.execution_id;
  errorContext.executionId = id;
  const start = run('harness-native-stage.mjs', ['start', '--execution-id', id, ...(verbose ? ['--verbose'] : [])]);
  if (start.status !== 0) throw childFailure(start, { prepared_execution_id: id });
  const started = lastJson(start.stdout);
  if (!started) throw new Error('harness-native-stage.mjs start printed no result');
  const launched = launchResult({ prepared, started });
  const takenOver = taken ? { taken_over: { previous_execution_id: taken.execution_id, previous_session_id: taken.previous_session_id, verified: taken.verified, ...(verbose ? { backup: taken.backup } : {}) } } : {};
  return verbose ? { ...launched, ...takenOver, input: prepared.input } : { ...launched, ...takenOver };
}

try {
  const [requestedAction, ...rest] = process.argv.slice(2), opts = {};
  let action = requestedAction;
  errorContext.action = action;
  const { args, verbose } = extractVerbose(rest);
  if (action === 'launch') {
    process.stdout.write(`${JSON.stringify(launchStage(args, verbose))}\n`);
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'reason', 'agent-id'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid native stage arguments');
    opts[key] = args[i + 1];
  }
  if (!['start', 'inspect', 'reconcile', 'bind', 'receive', 'finish', 'fail', 'cancel'].includes(action) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Usage: harness-native-stage.mjs launch --stage-id STAGE [prepare options] | start|inspect|reconcile|bind|receive|finish|fail|cancel --execution-id ID [--agent-id ID] [--reason TEXT] (run inside the workflow worktree; --root and --worktree-ref are found automatically)');
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
  if ((action === 'bind' || action === 'receive') !== Boolean(opts['agent-id'])) throw new Error('Native agent ID is required only for bind and receive');
  const session = await cliSession(root, opts['worktree-ref']);
  const input = await readExecutionInput({ root, execution_id: id });
  await validateSkillInput({ root, input });
  if (input.skill === 'spec-me' || input.context?.stage_id === 'spec-me') throw new Error('spec-me has been removed; continue from context-boundary with tactical-to-code');
  if (input.session_directory !== session || input.context?.worktree_ref !== opts['worktree-ref'] || input.context?.parent_execution_id || input.skill === 'workflow-compose') throw new Error('Invalid native stage workspace or input');
  errorContext.stageId = input.context?.stage_id || input.skill;
  const { workflow, stage } = await resolveWorkflowStage({ root, input });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage, workflowBinding: input.context?.workflow_binding || null, executionProvider: input.context?.provider || null });
  if ((input.context?.provider && input.context.provider !== binding.provider) || (input.context?.orchestrator_provider && input.context.orchestrator_provider !== binding.provider) || (input.context?.resume_provider && input.context.resume_provider !== binding.provider)) throw new Error('Execution provider must match the orchestrator and binding');
  const paths = stageExecutionPaths(root, id);
  if (action === 'start') {
    // An input prepared before the flow was complete (or by an older Harness) still cannot start a stage out of order.
    const flow = await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const orderViolation = flow ? preSpecOrderViolation((flow.state || flow).stages, input.context?.stage_id || input.skill) : null;
    if (orderViolation) throw new Error(orderViolation);
    const tacticalViolation = flow ? tacticalImplementationOrderViolation((flow.state || flow).stages, input.context?.stage_id || input.skill) : null;
    if (tacticalViolation) throw new Error(tacticalViolation);
    await writeOutputSchema({ root, input, prefix: `runtime/executions/${id}`, path: paths.files.schema, provider: binding.provider });
    const guide = [`.codex/internal-skills/${input.skill}/GUIDE.md`, `.agents/skills/${input.skill}/SKILL.md`, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
    if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
    const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
    await recordExecutionState({ root, input, binding, status: 'running', nativeClaim: true });
    const started = { execution_id: id, workspace: root, input_path: await executionInputAbsolutePath(root, id), guide: join(root, guide), schema_path: paths.files.schema, output_path: paths.files.raw, agent_profile: profile || 'workflow_stage', sandbox, binding };
    process.stdout.write(`${JSON.stringify(verbose ? started : compactStarted(started, { executionId: id }))}\n`);
  } else {
    const state = await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' });
    const current = (state.state || state).stages?.[input.context?.stage_id || input.skill];
    if (current?.status !== 'running' || current.execution_id !== id || !current.native_managed) throw new Error('Native stage is not running for this execution');
    if (action === 'inspect') {
      let observation = null;
      let threadId = null;
      if (binding.provider === 'codex' && current.native_agent_id) {
        const { resolveNativeCodexThread } = await import('../../.harness/src/workflow/native-context.mjs');
        threadId = await resolveNativeCodexThread({ root, parentSessionId: (state.state || state).orchestrator_session_id, stage: current });
      }
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
      const workflowState = state.state || state;
      const here = process.env.CODEX_THREAD_ID || null;
      let nativeOutcome = null;
      if (threadId) nativeOutcome = (await (await import('../../.harness/src/workflow/native-context.mjs')).readNativeCodexOutcome({ root, parentSessionId: workflowState.orchestrator_session_id, stage: current }).catch(() => null))?.status || null;
      const foreign = foreignRunningStage(workflowState, here);
      const finishable = foreign && nativeOutcome === 'completed' && existsSync(paths.files.raw);
      const next = finishable ? `Its agent completed and wrote its output; record it: ${nativeCommand('finish', id)}` : foreign ? takeoverStep(foreign) : null;
      process.stdout.write(`${JSON.stringify({ status: current.status, execution_id: id, agent_id: current.native_agent_id || null, thread_id: threadId, observation, ...(nativeOutcome ? { native_outcome: nativeOutcome } : {}), ...(here && workflowState.orchestrator_session_id ? { session: workflowState.orchestrator_session_id === here ? 'this' : 'other' } : {}), output_path: paths.files.raw, schema_path: paths.files.schema, ...(next ? { next } : {}) })}\n`);
      process.exit(0);
    }
    if (action === 'bind') {
      await recordExecutionState({ root, input, binding, status: 'running', nativeAgentId: opts['agent-id'] });
      process.stdout.write(`${JSON.stringify({ status: 'running', execution_id: id, agent_id: opts['agent-id'] })}\n`);
      process.exit(0);
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
      if (matches.length !== 1) {
        process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'agent_not_uniquely_reported' })}\n`);
        process.exit(0);
      }
      const hostStatus = matches[0].agent_status;
      if (hostStatus === 'running' || hostStatus === 'pending') {
        process.stdout.write(`${JSON.stringify({ status: 'running', execution_id: id, agent_id: current.native_agent_id })}\n`);
        process.exit(0);
      }
      const { readNativeCodexOutcome } = await import('../../.harness/src/workflow/native-context.mjs');
      const outcome = await readNativeCodexOutcome({ root, parentSessionId: input.context.orchestrator_session_id, stage: current });
      if (hostStatus && typeof hostStatus === 'object' && !Array.isArray(hostStatus) && Object.keys(hostStatus).length === 1 && Object.hasOwn(hostStatus, 'completed') && typeof hostStatus.completed === 'string') {
        if (outcome?.status !== 'completed' || outcome.output !== hostStatus.completed) {
          process.stdout.write(`${JSON.stringify({ status: 'unknown', execution_id: id, agent_id: current.native_agent_id, reason: 'completed_turn_not_verified' })}\n`);
          process.exit(0);
        }
        action = 'finish';
        if (!existsSync(paths.files.raw) && hostStatus.completed.trim()) {
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
      process.stdout.write(`${JSON.stringify({ status, execution_id: id, reason: opts.reason })}\n`);
      process.exit(0);
    }
    if (!current.native_agent_id) throw new Error('Native stage must be bound to the actual subagent ID');
    if (action === 'receive') {
      if (current.native_agent_id !== opts['agent-id']) throw new Error('Native subagent binding mismatch');
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Native output exceeds size limit'); }
      if (!text.trim()) throw new Error('Native subagent output is empty');
      await assertWorkspaceTarget(session, paths.refs.raw);
      const file = await open(paths.files.raw, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error('Native output must be a regular unshared file');
        await file.truncate(0);
        await file.writeFile(text);
      } finally { await file.close(); }
      process.stdout.write(`${JSON.stringify({ status: 'received', execution_id: id })}\n`);
      process.exit(0);
    }
    const schema = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.schema });
    let format, raw;
    try { raw = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.raw }); format = validateOutputFormat(raw, schema); }
    catch (error) {
      if (error.code === 'ENOENT') format = { valid: false, errors: [{ path: '$', rule: 'required', expected: 'output file', value: null, missing: true }] };
      else if (error instanceof SyntaxError) format = { valid: false, errors: [{ path: '$', rule: 'json', expected: 'valid JSON', value: null, message: error.message }] };
      else throw error;
    }
    if (!format.valid) { process.stdout.write(`${JSON.stringify(formatErrorResult({ executionId: id, errors: format.errors, schemaPath: paths.files.schema, outputPath: paths.files.raw, verbose }))}\n`); process.exit(1); }
    // The last tactical design stage (context-boundary) is accepted as completed only when the whole tactical-design.md passes the
    // gate, checked once before anything is committed or recorded; no earlier stage is gated. A rejection leaves the stage running;
    // every error names the stage that owns the failing section (`owner_stage`), the caller returns the errors to the same subagent,
    // and the same finish runs again.
    const { evaluateTacticalDesignGate, gateFailureInstruction } = await import('../../.harness/src/workflow/domain-model-gate.mjs');
    const gate = await evaluateTacticalDesignGate({ root, input, envelope: raw });
    if (gate && !gate.ok) {
      process.stdout.write(`${JSON.stringify(gateErrorResult({ gate: 'domain_model_check', executionId: id, stage: gate.stage, errors: gate.errors, instruction: gateFailureInstruction(gate), outputPath: paths.files.raw }))}\n`);
      process.exit(1);
    }
    if (binding.provider === 'claude-code' && input.context?.plan_set_id && ['to-ticket', 'sync-contracts'].includes(input.skill)) {
      const { assertNoUnrecordedNativeReview } = await import('../../.harness/src/workflow/review-attempts.mjs');
      const prefix = input.skill === 'to-ticket' ? 'plan' : 'contracts';
      const scope = `${prefix}-${input.context.plan_set_id}`;
      await assertNoUnrecordedNativeReview({ root, scope });
    }
    const { commitStageRequest, commitWorkflowDocuments } = await import('../../.harness/src/workflow/stage-commit.mjs');
    await commitStageRequest({ root, rawPath: paths.files.raw });
    try { execFileSync(process.execPath, [join(root, '.codex/scripts/harness-result.mjs'), '--root', root, '--worktree-ref', opts['worktree-ref'], '--execution-id', id, '--source', paths.refs.raw], { cwd: root, stdio: 'pipe' }); }
    catch (error) { throw new Error(`Result rejected: ${lastJson(error.stderr)?.error || String(error.stderr || error.message).trim()}`); }
    await commitWorkflowDocuments({ root, input, rawPath: paths.files.raw });
    const envelope = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.returned });
    const beforeTransition = input.skill === 'implement-wrapper' && input.context?.plan_id
      ? () => writeImplementationCheckpoint({ input, status: envelope.status, code: envelope.code, envelope, verified: true }) : null;
    try { await recordExecutionState({ root, input, binding, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref, nativeTerminalAgentId: current.native_agent_id || null, beforeTransition }); }
    catch (error) {
      if (!error.checkpointFailure) throw error;
      await recordExecutionState({ root, input, binding, status: 'failed', code: 'EXECUTION_ERROR', reason: error.message, nativeTerminalAgentId: current.native_agent_id || null });
      throw error;
    }
    process.stdout.write(`${JSON.stringify(verbose ? { status: envelope.status, code: envelope.code, result_ref: envelope.result_ref, result: envelope.result } : compactFinished({ envelope, stageId: errorContext.stageId, executionId: id }))}\n`);
  }
} catch (error) { writeError(process.stderr, error, errorContext); process.exitCode = 2; }
