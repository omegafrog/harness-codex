#!/usr/bin/env node
// Codex PreToolUse hook: refuse to start an agent that Harness requires to be fresh with a forked conversation.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FRESH_AGENT_TYPES = [
  'code_researcher', 'contract_reviewer', 'diagram_creator', 'e2e_test_runner', 'execution_runner',
  'frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer', 'human_approver',
  'implementation_agent', 'knowledge_claim_extractor', 'knowledge_principle_reviewer',
  'knowledge_principle_synthesizer', 'knowledge_source_researcher', 'plan_reviewer', 'pr_author', 'requirements_gap_reviewer',
  'spec_adversarial_reviewer', 'spec_reviewer', 'stage_document_writer', 'stakeholder_persona', 'standards_reviewer',
  'tactical_designer', 'tactical_implementation_agent', 'to_ticket', 'tracker_publisher', 'workflow_stage', 'workflow_stage_solo',
];

// Helper agents run on the configured low-performance model of the consumer, not on the parent's. An agent profile file
// cannot carry that value without making every installed copy differ from its source (lock hashes, Doctor drift, setup
// changes), so the start itself is checked here against agents.codex in .harness/harness.yaml.
const HELPER_SKILLS = { code_researcher: 'code-research', stakeholder_persona: 'stakeholder-persona', requirements_gap_reviewer: 'requirements-gap-review' };

function workflowWorktreeRoot(start) {
  let directory = typeof start === 'string' ? start : '';
  for (let depth = 0; directory && depth < 12; depth += 1) {
    if (existsSync(join(directory, '.io/worktree.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

// The configured { model, reasoning_effort } of a helper type in a workflow worktree, or null when it cannot be read.
export function helperBinding(agentType, cwd) {
  try {
    const skill = HELPER_SKILLS[agentType], root = skill && workflowWorktreeRoot(cwd);
    if (!root) return null;
    const guide = readFileSync(join(root, `.harness/internal-skills/${skill}/GUIDE.md`), 'utf8');
    const tier = /^---\r?\n(?:[^\n]*\r?\n)*?model_tier:[ \t]*["']?([a-z_]+)["']?[ \t]*\r?\n/.exec(guide)?.[1];
    if (!tier) return null;
    const lines = readFileSync(join(root, '.harness/harness.yaml'), 'utf8').split(/\r?\n/);
    const value = (key) => {
      let inAgents = false, inCodex = false;
      for (const line of lines) {
        if (/^\S/.test(line)) { inAgents = /^agents:\s*(#.*)?$/.test(line); inCodex = false; continue; }
        if (!inAgents) continue;
        if (/^ {2}\S/.test(line)) { inCodex = /^ {2}codex:\s*(#.*)?$/.test(line); continue; }
        const match = inCodex && new RegExp(`^ {4}${key}:[ \\t]*(.*?)[ \\t]*$`).exec(line);
        if (match) return match[1].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
      }
      return null;
    };
    const model = value(`${tier}_model`), reasoning_effort = value(`${tier}_reasoning_effort`);
    return model && reasoning_effort ? { model, reasoning_effort } : null;
  } catch { return null; }
}

export function freshAgentDecision(event) {
  if (event?.hook_event_name !== 'PreToolUse' || !/spawn_agent$/.test(event.tool_name || '')) return null;
  const input = event.tool_input || {};
  if (!FRESH_AGENT_TYPES.includes(input.agent_type)) return null;
  if (input.fork_turns === 'none') {
    const binding = helperBinding(input.agent_type, event.cwd);
    if (!binding || (input.model === binding.model && input.reasoning_effort === binding.reasoning_effort)) return null;
    return `Harness: ${input.agent_type} runs on the configured low-performance binding. Nothing was started. Call spawn_agent again with fork_turns "none", model "${binding.model}" and reasoning_effort "${binding.reasoning_effort}" (it received model ${input.model ?? 'unset'} and reasoning_effort ${input.reasoning_effort ?? 'unset'}); this denial is not a stage failure, so do not call finish or fail because of it.`;
  }
  return `Harness: ${input.agent_type} must start with a fresh context. Nothing was started. Call spawn_agent again with fork_turns "none" and pass what it needs in the message; this denial is not a stage failure, so do not call finish or fail because of it.`;
}

export async function runFreshAgentHook() {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const reason = freshAgentDecision(JSON.parse(text));
    if (reason) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runFreshAgentHook();
