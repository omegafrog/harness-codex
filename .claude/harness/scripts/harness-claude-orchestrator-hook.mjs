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
  const explicitlyInvoked = typeof event.prompt === 'string' && /(?:^|[\s[(])(?:\$|\/)orchestrator(?=$|[\s)\]])/i.test(event.prompt);
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
  const { isHarnessUpdateRequest } = await import(new URL('../../../.harness/src/workflow/request-routing.mjs', import.meta.url));
  const maintenance = event.hook_event_name === 'UserPromptSubmit' && isHarnessUpdateRequest(event.prompt);
  const inputState = observed;
  // User input belongs only to the verified worktree containing the current directory.
  const otherSkill = event.hook_event_name === 'UserPromptSubmit' && !explicitlyInvoked && /^\s*(?:\$[a-z][\w-]*|\/(?:setup|eli5)\b)/i.test(event.prompt || '');
  const candidate = maintenance || otherSkill ? null : orchestratorInputTarget(inputState);
  const target = event.hook_event_name === 'UserPromptSubmit' && !explicitlyInvoked && (!event.session_id || !candidate?.orchestrator?.session_id || candidate.orchestrator.session_id !== event.session_id || candidate?.orchestrator?.provider !== 'claude-code') ? null : candidate;
  const inputRoot = target?.workspace_root || null;
  inputState.input_worktree_ref = target?.record_path || null;
  inputState.input_routing = target ? 'local' : 'unbound';
  if (!uninitialized && inputRoot) {
    const { recordUserInput } = await import(new URL('../../../.harness/src/workflow/user-inputs.mjs', import.meta.url));
    await recordUserInput({ root: inputRoot, event });
  }
  // Capture input against pre-bind ownership, then refresh so first-prompt binding is visible this turn.
  if (!uninitialized && !maintenance && explicitlyInvoked && event.hook_event_name === 'UserPromptSubmit') {
    await bindOrchestratorSession({ root, provider: 'claude-code', sessionId: event.session_id });
    try { observed = await inspectStartupState({ workspaceRoot: root, sessionId: event.session_id, provider: 'claude-code' }); }
    catch (error) { observed = { ...inputState, decision_hint: 'inspect_required', reason: error.message }; }
    observed.input_worktree_ref = inputState.input_worktree_ref;
    observed.input_routing = inputState.input_routing;
  }
  if (event.hook_event_name === 'UserPromptSubmit' && !explicitlyInvoked) process.exit(0);
  if (maintenance) { observed.decision_hint = 'maintenance_candidate'; observed.reason = 'Harness update requested; use harness-maintenance in the current workspace'; }
  if (event.hook_event_name === 'UserPromptSubmit' && observed.decision_hint === 'compose_candidate') {
    const { inspectSetupConfiguration } = await import(new URL('../../../.harness/src/workflow/project-readiness.mjs', import.meta.url));
    observed.setup_configuration = await inspectSetupConfiguration({ workspace_root: root, provider: 'claude-code' });
    if (observed.setup_configuration.status === 'setup_required') { observed.decision_hint = 'setup_candidate'; observed.reason = 'Required setup configuration is missing or invalid'; }
  }
  const progress = uninitialized ? null : await refreshWorkflowProgress(observed, event.hook_event_name);
  if (event.hook_event_name !== 'UserPromptSubmit') process.exit(0);
  const updateNotice = uninitialized ? null : await harnessUpdateNotice({ root, sessionId: event.session_id }).catch(() => null);
  const context = `Harness workflow startup context for Claude Code. Read ${orchestrator} and follow it in this main session; do not delegate workflow routing itself. Observed state: ${JSON.stringify(observed)}. Progress snapshot: ${JSON.stringify(progress)}. For maintenance_candidate follow .codex/internal-skills/harness-maintenance/GUIDE.md in the current checkout; never create a workflow or worktree for an update request. A linked worktree can be orchestrated only while the current working directory is inside that worktree. Never route prompts, answers or stage commands from the primary checkout to a linked worktree using --root or --worktree-ref. If decision_hint is worktree_required, identify the matching candidate and ask the user to change directory to its workspace_root before invoking the orchestrator. For a new request from the primary checkout, compose and verify the worktree, then stop and give its absolute path; the user enters that directory and invokes the orchestrator to start the first stage. In a linked worktree, route decisions only locally. For a new workflow in a linked worktree without existing workflow state, compose in that same worktree and continue there; never create another worktree. Never select by newest record. For new composition pass --orchestrator-provider claude-code --orchestrator-session-id ${event.session_id || '<this Claude session id>'} and invoke compose with a fresh execution ID. Verify the invocation result and binding. In the primary checkout verify the new worktree against the pre-creation Git list and stop; in an existing linked worktree verify the returned workspace is the current one and continue locally. Follow ${composer} and .codex/internal-skills/skill-execution/GUIDE.md. Use required independent reviewer roles. The hook records input only in the current worktree; it never creates worktrees or transitions workflow state.${updateNotice ? ` ${updateNotice}` : ''}`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
