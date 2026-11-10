#!/usr/bin/env node
// Codex PreToolUse hook: refuse to start an agent that Harness requires to be fresh with a forked conversation.
// A reviewer or E2E runner that inherits the caller's turns is not independent, and it costs the whole history.
export const FRESH_AGENT_TYPES = ['standards_reviewer', 'spec_reviewer', 'spec_adversarial_reviewer', 'plan_reviewer', 'e2e_test_runner'];

export function freshAgentDecision(event) {
  if (event?.hook_event_name !== 'PreToolUse' || !/spawn_agent$/.test(event.tool_name || '')) return null;
  const input = event.tool_input || {};
  if (!FRESH_AGENT_TYPES.includes(input.agent_type) || input.fork_turns === 'none') return null;
  return `Harness: ${input.agent_type} must start with a fresh context. Call spawn_agent again with fork_turns "none" and pass what it needs in the message.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const reason = freshAgentDecision(JSON.parse(text));
    if (reason) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); }
}
