#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/startup-state.mjs', import.meta.url);
const { inspectStartupState, refreshWorkflowProgress } = await import(existsSync(installed) && !sourceCheckout ? installed.href : new URL('../../src/workflow/startup-state.mjs', import.meta.url).href);

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (!['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event.hook_event_name) || event.agent_id || process.env.HARNESS_SKILL_EXECUTION_ID) process.exit(0);
  if (typeof event.cwd !== 'string') throw new Error('Hook cwd is required');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: event.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const orchestrator = ['.codex/skills/orchestrator/SKILL.md', '.agents/skills/orchestrator/SKILL.md'].map((path) => resolve(root, path)).find(existsSync);
  const composer = resolve(root, '.codex/internal-skills/workflow-compose/GUIDE.md');
  if (!orchestrator || !existsSync(composer)) throw new Error('Harness orchestrator/workflow-compose skill is missing');
  let observed;
  try { observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: event.session_id }); }
  catch (error) { observed = { decision_hint: 'inspect_required', reason: error.message, codex_session_id: event.session_id || null }; }
  const progress = await refreshWorkflowProgress(observed, event.hook_event_name);
  if (event.hook_event_name !== 'UserPromptSubmit') process.exit(0);
  const context = `Harness workflow startup hook. In the main session, read ${orchestrator}. Observed state (read-only worktree.json/orchestrator files and Git CLI): ${JSON.stringify(observed)}. Progress snapshot: ${JSON.stringify(progress)}. These are lifecycle observations, not a determination of whether the user's message is a new task. When resuming, use the recorded orchestrator_session_id and agent_sessions from the active workflow's canonical worktree record; continue the latest matching Codex conversations for the current stage instead of starting fresh agents or reconstructing their input/results from files. For resume_candidate, inspect the canonical workflow/state; if handoff_required is true, report handoff_workspace and instruct the user to start a new Codex session there without running any workflow stage in the original session. In the prepared worktree session only, select the next eligible stage from workflow.json stages, state, dependencies and gates regardless of Codex session ID. For compose_candidate, compose only if the message actually requests new work. For inspect_required, resolve missing, mismatched or unassigned records before proceeding; never adopt a workflow from another repository or an unverified worktree. When new composition is needed, dispatch ${composer} using the independent commands in .codex/internal-skills/static-caller/GUIDE.md, validate its status envelope and workflow file, then report the absolute new worktree path to the user and STOP. Do not prepare or execute any downstream workflow stage in the original session. The user must open the new worktree in a fresh Codex session and invoke orchestrator there before stage dispatch. Pass this hook codex_session_id and stage_id in execution input.context for diagnostics. Use harness-execution-state.mjs to record stage start/result/failure and refresh progress. Do not edit workflow execution state in the main session. Never spawn an orchestrator agent. Child executions with execution_id perform only their assigned skill and return. The hook refreshes only runtime/orchestrator/progress.json; it never changes workflow/state records or creates worktrees.`;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
