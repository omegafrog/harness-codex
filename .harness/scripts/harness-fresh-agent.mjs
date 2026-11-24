#!/usr/bin/env node
// Codex PreToolUse hook: refuse to start an agent that Harness requires to be fresh with a forked conversation.
export const FRESH_AGENT_TYPES = [
  'code_researcher', 'contract_reviewer', 'diagram_creator', 'e2e_test_runner', 'execution_runner',
  'frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer', 'human_approver',
  'implementation_agent', 'knowledge_claim_extractor', 'knowledge_principle_reviewer',
  'knowledge_principle_synthesizer', 'knowledge_source_researcher', 'plan_reviewer', 'pr_author',
  'spec_adversarial_reviewer', 'spec_reviewer', 'stage_document_writer', 'stakeholder_persona', 'standards_reviewer',
  'tactical_designer', 'tactical_implementation_agent', 'to_ticket', 'tracker_publisher', 'workflow_stage',
];

export function freshAgentDecision(event) {
  if (event?.hook_event_name !== 'PreToolUse' || !/spawn_agent$/.test(event.tool_name || '')) return null;
  const input = event.tool_input || {};
  if (!FRESH_AGENT_TYPES.includes(input.agent_type) || input.fork_turns === 'none') return null;
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
