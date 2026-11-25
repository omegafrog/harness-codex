#!/usr/bin/env node
// `hook`: Claude Code PreCompact hook. `unit-done --agent-id ID`: a worker records that it is between two units of work.
import { compactionDecision, recordUnitBoundary } from '../../.harness/src/workflow/compaction-boundary.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';
import { FRESH_AGENT_TYPES } from '../../.harness/scripts/harness-fresh-agent.mjs';

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'hook') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const decision = compactionDecision(JSON.parse(text), FRESH_AGENT_TYPES);
    if (decision?.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: decision.block })}\n`);
    else if (decision?.instructions) process.stdout.write(`${decision.instructions}\n`);
  } else if (action === 'unit-done' && args.length === 2 && args[0] === '--agent-id') {
    const recorded = recordUnitBoundary(resolveCommandContext().root, args[1]);
    process.stdout.write(`${JSON.stringify({ status: recorded ? 'boundary_recorded' : 'no_compaction_waiting' })}\n`);
  } else throw new Error('Usage: harness-compaction.mjs hook | unit-done --agent-id <agent_id>');
} catch (error) {
  // A broken hook must never stop a session: Claude Code then compacts as it would without Harness.
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
