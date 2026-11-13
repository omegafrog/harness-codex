#!/usr/bin/env node
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { assertWorkspaceTarget } from '../../.harness/src/eval/case-workspace.mjs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { cliSession } from '../../.harness/src/workflow/cli-session.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { executionInputAbsolutePath } from '../../.harness/src/workflow/execution-input.mjs';
import { recordExecutionState } from '../../.harness/src/workflow/execution-state.mjs';
import { readExecutionInput, readSkillSessionJson, resolveAgentSandbox, resolveSkillBinding, resolveWorkflowStage, validateSkillInput } from '../../.harness/src/workflow/skill-execution.mjs';
import { stageExecutionPaths } from '../../.harness/src/workflow/session-output.mjs';
import { validateOutputFormat, writeOutputSchema } from '../../.harness/src/workflow/output-schema.mjs';
import { publishStageResultEvent } from '../../.harness/src/workflow/stage-result-events.mjs';

try {
  const [action, ...args] = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'reason', 'agent-id'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Invalid native stage arguments');
    opts[key] = args[i + 1];
  }
  if (!['start', 'bind', 'receive', 'finish', 'fail', 'cancel'].includes(action) || !isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Usage: harness-native-stage.mjs start|bind|receive|finish|fail|cancel --root ROOT --worktree-ref REF --execution-id ID');
  const root = opts.root, id = opts['execution-id'];
  resolveCommandContext({ root, worktreeRef: opts['worktree-ref'] });
  if (['fail', 'cancel'].includes(action) && !opts.reason?.trim()) throw new Error('A native subagent failure reason is required');
  if (!['fail', 'cancel'].includes(action) && opts.reason) throw new Error('Failure reason applies only to fail');
  if ((action === 'bind' || action === 'receive') !== Boolean(opts['agent-id'])) throw new Error('Native agent ID is required only for bind and receive');
  const session = await cliSession(root, opts['worktree-ref']);
  const input = await readExecutionInput({ root, execution_id: id });
  await validateSkillInput({ root, input });
  if (input.session_directory !== session || input.context?.worktree_ref !== opts['worktree-ref'] || input.context?.parent_execution_id || input.skill === 'workflow-compose') throw new Error('Invalid native stage workspace or input');
  const { workflow, stage } = await resolveWorkflowStage({ root, input });
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow, stage, workflowBinding: input.context?.workflow_binding || null, executionProvider: input.context?.provider || null });
  if ((input.context?.provider && input.context.provider !== binding.provider) || (input.context?.orchestrator_provider && input.context.orchestrator_provider !== binding.provider) || (input.context?.resume_provider && input.context.resume_provider !== binding.provider)) throw new Error('Execution provider must match the orchestrator and binding');
  const paths = stageExecutionPaths(root, id);
  if (action === 'start') {
    await writeOutputSchema({ root, input, prefix: `runtime/executions/${id}`, path: paths.files.schema, provider: binding.provider });
    const guide = [`.codex/internal-skills/${input.skill}/GUIDE.md`, `.agents/skills/${input.skill}/SKILL.md`, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
    if (!guide) throw new Error(`Skill instruction is missing: ${input.skill}`);
    const { profile, sandbox } = await resolveAgentSandbox({ root, input, workflow, stage });
    await recordExecutionState({ root, input, binding, status: 'running', nativeClaim: true });
    process.stdout.write(`${JSON.stringify({ execution_id: id, workspace: root, input_path: await executionInputAbsolutePath(root, id), guide: join(root, guide), schema_path: paths.files.schema, output_path: paths.files.raw, agent_profile: profile || 'workflow_stage', sandbox, binding })}\n`);
  } else {
    const state = await readSkillSessionJson({ root, session_directory: input.context?.control_session_directory || session, path: input.context?.workflow_ref ? 'runtime/orchestrator/workflow.json' : 'runtime/orchestrator/state.json' });
    const current = (state.state || state).stages?.[input.context?.stage_id || input.skill];
    if (current?.status !== 'running' || current.execution_id !== id || !current.native_managed) throw new Error('Native stage is not running for this execution');
    if (action === 'bind') {
      await recordExecutionState({ root, input, binding, status: 'running', nativeAgentId: opts['agent-id'] });
      process.stdout.write(`${JSON.stringify({ status: 'running', execution_id: id, agent_id: opts['agent-id'] })}\n`);
      process.exit(0);
    }
    if (action === 'fail' || action === 'cancel') {
      const status = action === 'cancel' ? 'cancelled' : 'failed';
      await recordExecutionState({ root, input, binding, status, code: status === 'cancelled' ? 'CANCELLED' : 'EXECUTION_ERROR', reason: opts.reason });
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
    let format;
    try { format = validateOutputFormat(await readSkillSessionJson({ root, session_directory: session, path: paths.refs.raw }), schema); }
    catch (error) {
      if (error.code === 'ENOENT') format = { valid: false, errors: [{ path: '$', rule: 'required', expected: 'output file', value: null, missing: true }] };
      else if (error instanceof SyntaxError) format = { valid: false, errors: [{ path: '$', rule: 'json', expected: 'valid JSON', value: null, message: error.message }] };
      else throw error;
    }
    if (!format.valid) { process.stdout.write(`${JSON.stringify({ status: 'format_error', execution_id: id, errors: format.errors, schema_path: paths.files.schema, output_path: paths.files.raw })}\n`); process.exit(1); }
    if (binding.provider === 'claude-code' && input.context?.plan_set_id && ['spec-me', 'to-ticket', 'sync-contracts'].includes(input.skill)) {
      const { assertNoUnrecordedNativeReview } = await import('../../.harness/src/workflow/review-attempts.mjs');
      const prefix = input.skill === 'spec-me' ? 'spec' : input.skill === 'to-ticket' ? 'plan' : 'contracts';
      const scope = `${prefix}-${input.context.plan_set_id}${input.skill === 'spec-me' ? '-architecture' : ''}`;
      await assertNoUnrecordedNativeReview({ root, scope });
    }
    const { commitStageRequest, commitWorkflowDocuments } = await import('../../.harness/src/workflow/stage-commit.mjs');
    await commitStageRequest({ root, rawPath: paths.files.raw });
    execFileSync(process.execPath, [join(root, '.codex/scripts/harness-result.mjs'), '--root', root, '--worktree-ref', opts['worktree-ref'], '--execution-id', id, '--source', paths.refs.raw], { cwd: root, stdio: 'pipe' });
    await commitWorkflowDocuments({ root, input, rawPath: paths.files.raw });
    const envelope = await readSkillSessionJson({ root, session_directory: session, path: paths.refs.returned });
    const event = await publishStageResultEvent({ root, input, envelope, binding, hostDelivery: false, observed: true });
    process.stdout.write(`${JSON.stringify({ status: event.status, code: event.code, result_ref: event.result_ref, result: envelope.result })}\n`);
  }
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 2; }
