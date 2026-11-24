#!/usr/bin/env node
import { isAbsolute } from 'node:path';
const USAGE = `Usage (primary checkout or an existing linked worktree, cwd = that workspace):
  node .harness/scripts/harness-compose-workspace.mjs --root <absolute workspace> --execution-id <new execution ID> \\
    --plan-set-id <feature slug> --request <original user request> \\
    --orchestrator-provider <provider from harness-context.mjs --entry> --orchestrator-session-id <session_id from harness-context.mjs --entry>
Example:
  node .harness/scripts/harness-compose-workspace.mjs --root "$PWD" --execution-id compose-20261121-a1 \\
    --plan-set-id calculator-web-app --request '계산기 웹 앱 만들어' \\
    --orchestrator-provider codex --orchestrator-session-id <session_id>
Options: --root and --execution-id are required; --request creates or links the workflow worktree.
Without --request it prepares an existing workflow-compose input (--worktree-ref <worktree.json> optional).
Optional env: HARNESS_WORKFLOW_BINDING='{"provider":"codex","model":"...","reasoning_effort":"medium"}'.
Prints one JSON record (execution_id, worktree_ref, ...) on stdout; read the new input and result through refs.*.absolute
(input_path is relative to the new workspace, result_ref to its session directory). Errors are JSON on stderr with exit 1.`;
if (['--help', '-h'].includes(process.argv[2])) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
const installed = new URL('../../.harness/src/workflow/', import.meta.url);
const { resolveSkillSession, readSkillSessionJson, readExecutionInput, validateSkillInput } = await import(new URL('stage-runtime.mjs', installed));
const { createComposerWorkspace, prepareComposerWorkspace } = await import(new URL('composer-workspace.mjs', installed));
const { parseWorkflowBinding } = await import(new URL('providers/index.mjs', installed));
const { findExecutionInput } = await import(new URL('execution-input.mjs', installed));
const { cliSession } = await import(new URL('cli-session.mjs', installed));
try {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['root', 'worktree-ref', 'execution-id', 'plan-set-id', 'request', 'orchestrator-session-id', 'orchestrator-provider'].includes(k) || !args[i + 1] || Object.hasOwn(opts, k)) throw new Error(`Invalid argument: ${args[i]}; see --help`);
    opts[k] = args[i + 1];
  }
  if (!isAbsolute(opts.root || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts['execution-id'] || '')) throw new Error('Absolute root and execution-id are required; see --help');
  if (opts.request !== undefined) {
    const record = await createComposerWorkspace({ root: opts.root, plan_set_id: opts['plan-set-id'], request: opts.request, execution_id: opts['execution-id'], orchestrator_session_id: opts['orchestrator-session-id'] || null, orchestrator_provider: opts['orchestrator-provider'] || null, workflow_binding: parseWorkflowBinding(process.env.HARNESS_WORKFLOW_BINDING) });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    process.exit(0);
  }
  const session = await cliSession(opts.root, opts['worktree-ref']);
  const input = await readExecutionInput({ root: opts.root, execution_id: opts['execution-id'] });
  if (input.execution_id !== opts['execution-id']) throw new Error('Input execution ID mismatch');
  if (input.skill !== 'workflow-compose') throw new Error('Expected workflow-compose input');
  await validateSkillInput({ root: opts.root, input });
  const location = await findExecutionInput(opts.root, opts['execution-id']);
  if (location.workspace !== opts.root) throw new Error('Compose input is outside workspace');
  const record = await prepareComposerWorkspace({ root: opts.root, session, input, inputPath: location.path });
  process.stdout.write(`${JSON.stringify(record)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
