#!/usr/bin/env node
import { isAbsolute } from 'node:path';
const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput, validateSkillReturn, resolveSkillBinding } = await import(new URL('skill-execution.mjs', installed));
const { recordExecutionState, processIdentity, assertExecutionStopped } = await import(new URL('execution-state.mjs', installed));
const { cliSession } = await import(new URL('cli-session.mjs', installed));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'status', 'code', 'result-ref', 'reason', 'owner-pid', 'child-pid', 'workflow', 'stage', 'recover-from-execution-id'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || (!opts['recover-from-execution-id'] && !['running', 'completed', 'action_required', 'blocked', 'failed', 'cancelled'].includes(opts.status))) throw new Error('Absolute root, execution-id and valid status are required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Valid execution-id is required');
  if (opts.status === 'running') throw new Error('Runner records running state; invoke harness-agent-run.mjs directly');
  const session = await cliSession(opts.root, opts['worktree-ref']);
  if (opts['recover-from-execution-id']) {
    const currentInput = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
    const priorInput = await readExecutionInput({ root: opts.root, execution_id: opts['recover-from-execution-id'] });
    if (currentInput.skill !== priorInput.skill || currentInput.context?.stage_id !== priorInput.context?.stage_id || currentInput.context?.worktree_ref !== priorInput.context?.worktree_ref || currentInput.context?.worktree_ref !== opts['worktree-ref']) throw new Error('Recovery executions do not belong to the same canonical stage');
    const state = await readSkillSessionJson({ root: opts.root, session_directory: session, path: 'runtime/orchestrator/state.json' });
    const current = state.stages?.[state.current_stage];
    const preserved = current?.attempts?.find((attempt) => attempt.execution_id === priorInput.execution_id);
    if (state.current_stage !== currentInput.context.stage_id || current?.execution_id !== currentInput.execution_id || current?.status !== 'failed' || !preserved) throw new Error('Recovery target is not preserved under the failed current stage');
    await assertExecutionStopped(current, { root: opts.root, session });
    await assertExecutionStopped(preserved, { root: opts.root, session: await resolveSkillSession(opts.root, priorInput.context?.control_session_directory || priorInput.session_directory) });
    const priorSession = await resolveSkillSession(opts.root, priorInput.session_directory);
    const envelope = await readSkillSessionJson({ root: opts.root, session_directory: priorSession, path: `runtime/executions/${priorInput.execution_id}/return.json` });
    await validateSkillReturn({ root: opts.root, input: priorInput, envelope });
    const binding = await resolveSkillBinding({ root: opts.root, skill: priorInput.skill, workflow: opts.workflow || null, stage: opts.stage || null, workflowBinding: priorInput.context?.workflow_binding || null });
    await recordExecutionState({ root: opts.root, input: priorInput, binding, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref, recoverFromExecutionId: priorInput.execution_id });
    const result = await readSkillSessionJson({ root: opts.root, session_directory: session, path: 'runtime/orchestrator/state.json' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  await validateSkillInput({ root: opts.root, input });
  const binding = await resolveSkillBinding({ root: opts.root, skill: input.skill, workflow: opts.workflow || null, stage: opts.stage || null, workflowBinding: input.context?.workflow_binding || null });
  const owner = opts['owner-pid'] ? await processIdentity(Number(opts['owner-pid'])) : null;
  const child = opts['child-pid'] ? await processIdentity(Number(opts['child-pid'])) : null;
  const result = await recordExecutionState({ root: opts.root, input, binding, status: opts.status, code: opts.code ?? null, result_ref: opts['result-ref'] ?? null, reason: opts.reason ?? null, owner, child });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
