import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freshAgentDecision } from '../.codex/scripts/harness-fresh-agent.mjs';
import { codexFreshAgentHook } from '../.harness/src/workflow/providers/codex.mjs';

const spawn = (input) => ({ hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent', tool_input: input });

// Codex reports spawn_agent to PreToolUse with its fork_turns, so a forked reviewer is refused before it runs.
test('the fresh-agent hook refuses forked reviewers and E2E runners and lets other agents through', () => {
  for (const agent of ['standards_reviewer', 'spec_reviewer', 'spec_adversarial_reviewer', 'plan_reviewer', 'contract_reviewer', 'e2e_test_runner']) {
    assert.match(freshAgentDecision(spawn({ agent_type: agent, fork_turns: 'all', message: 'x' })), /fork_turns "none"/);
    assert.match(freshAgentDecision(spawn({ agent_type: agent, message: 'x' })), /fresh context/, 'an omitted fork_turns is refused too');
    assert.equal(freshAgentDecision(spawn({ agent_type: agent, fork_turns: 'none', message: 'x' })), null);
  }
  assert.equal(freshAgentDecision(spawn({ agent_type: 'code_researcher', fork_turns: 'all' })), null);
  assert.equal(freshAgentDecision({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'ls' } }), null);
  // The installed shell filter runs the script for spawn_agent calls and prints the deny decision.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = (event) => spawnSync('sh', ['-c', codexFreshAgentHook().command], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, HARNESS_WORKSPACE_ROOT: root } });
  assert.equal(JSON.parse(run(spawn({ agent_type: 'spec_reviewer', fork_turns: 'all' })).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'ls' } }).stdout, '');
});
