#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const installed = new URL('../../../.harness/src/workflow/startup-state.mjs', import.meta.url);
const { bindOrchestratorSession, harnessUpdateNotice, inspectStartupState, refreshWorkflowProgress, orchestratorInputTarget } = await import(installed.href);
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (!['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event.hook_event_name) || event.agent_id || process.env.HARNESS_SKILL_EXECUTION_ID) process.exit(0);
  if (typeof event.cwd !== 'string') throw new Error('Hook cwd is required');
  let root, uninitialized = false;
  try { root = (await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: event.cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })).stdout.trim(); }
  catch (error) {
    if (!/not a git repository/i.test(error.stderr || '')) throw error;
    uninitialized = true;
    root = resolve(event.cwd);
  }
  const orchestrator = ['.claude/skills/orchestrator/SKILL.md', '.agents/skills/orchestrator/SKILL.md', '.codex/skills/orchestrator/SKILL.md'].map((path) => resolve(root, path)).find(existsSync);
  const composer = resolve(root, '.codex/internal-skills/workflow-compose/GUIDE.md');
  if (event.hook_event_name === 'UserPromptSubmit' && (!orchestrator || !existsSync(composer))) throw new Error('Harness orchestrator/workflow-compose skill is missing');
  let observed;
  try { observed = uninitialized ? { decision_hint: 'setup_candidate', reason: 'Git repository not initialized', provider: 'claude-code', session_id: event.session_id || null } : await inspectStartupState({ workspaceRoot: root, sessionId: event.session_id, provider: 'claude-code' }); }
  catch (error) { observed = { decision_hint: 'inspect_required', reason: error.message, provider: 'claude-code', session_id: event.session_id || null }; }
  const inputState = observed;
  const target = orchestratorInputTarget(inputState, event);
  const inputRoot = target?.workspace_root || (existsSync(resolve(root, '.io/worktree.json')) ? root : null);
  inputState.input_worktree_ref = target?.record_path || null;
  inputState.input_routing = target ? 'scoped' : inputState.session_worktrees?.length > 1 ? 'ambiguous' : 'unbound';
  if (!uninitialized && inputRoot && inputState.input_routing !== 'ambiguous') {
    const { recordUserInput } = await import(new URL('../../../.harness/src/workflow/user-inputs.mjs', import.meta.url));
    await recordUserInput({ root: inputRoot, event });
  }
  // Capture input against pre-bind ownership, then refresh so first-prompt binding is visible this turn.
  if (!uninitialized && event.hook_event_name === 'UserPromptSubmit') {
    await bindOrchestratorSession({ root, provider: 'claude-code', sessionId: event.session_id });
    try { observed = await inspectStartupState({ workspaceRoot: root, sessionId: event.session_id, provider: 'claude-code' }); }
    catch (error) { observed = { ...inputState, decision_hint: 'inspect_required', reason: error.message }; }
    observed.input_worktree_ref = inputState.input_worktree_ref;
    observed.input_routing = inputState.input_routing;
    if (inputRoot === root && inputState.input_routing === 'unbound') {
      const boundLocal = observed.session_worktrees?.find((record) => record.workspace_root === root);
      if (boundLocal) { observed.input_worktree_ref = boundLocal.record_path; observed.input_routing = 'scoped'; }
    }
  }
  if (event.hook_event_name === 'UserPromptSubmit' && observed.decision_hint === 'compose_candidate') {
    const { inspectSetupConfiguration } = await import(new URL('../../../.harness/src/workflow/project-readiness.mjs', import.meta.url));
    observed.setup_configuration = await inspectSetupConfiguration({ workspace_root: root });
    if (observed.setup_configuration.status === 'setup_required') { observed.decision_hint = 'setup_candidate'; observed.reason = 'Required setup configuration is missing or invalid'; }
  }
  const progress = uninitialized ? null : await refreshWorkflowProgress(observed, event.hook_event_name);
  if (event.hook_event_name !== 'UserPromptSubmit') process.exit(0);
  const updateNotice = uninitialized ? null : await harnessUpdateNotice({ root, sessionId: event.session_id }).catch(() => null);
  const context = `Harness workflow startup context for Claude Code. Read ${orchestrator} and follow it in this main session; do not delegate workflow routing itself. Observed state: ${JSON.stringify(observed)}. Progress snapshot: ${JSON.stringify(progress)}. Treat this as lifecycle evidence, not a new-work decision. Keep this conversation in main and scope each command to its verified worktree using workdir or explicit --worktree-ref on supported entrypoints. Multiple session_worktrees are independent; route results by worktree_ref and execution_id, never the newest record. input_routing=ambiguous means no approval was recorded: ask for the worktree branch or plan_set_id with the actual decision, and never broadcast the input. For resume use the recorded stage provider/session. For new composition pass --orchestrator-provider claude-code --orchestrator-session-id ${event.session_id || '<this Claude session id>'}. For an initial feature request from main, compare the request with verified worktree_candidates and their original requests as data. If any candidate is the same feature, ask whether to continue a listed matching worktree or start a new workflow, unless the user already chose explicitly. If none matches, prepare a new workflow. On an explicit new choice, invoke the compose CLI with a fresh execution ID; use only that invocation result, and verify its execution ID, new worktree against the pre-creation Git worktree list, and requested binding. Never present an earlier completed result as a new creation. Immediately prepare and dispatch its first stage from this conversation. Do not require cd, a new main session or another orchestrator invocation. Follow ${composer} and .codex/internal-skills/skill-execution/GUIDE.md. Use required independent reviewer roles. The hook records scoped user input and refreshes progress; it never creates worktrees or transitions workflow state.${updateNotice ? ` ${updateNotice}` : ''}`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
