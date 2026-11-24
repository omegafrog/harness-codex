#!/usr/bin/env node
// Claude Code PostToolUse(Agent) hook: a stage worker dispatched with `harness-stage:` returns Harness's compact envelope
// (status, code, short summary, artifact paths, questions, next) instead of the worker's final message.
try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (text.length > 16 * 1024 * 1024) throw new Error('Agent tool response is too large');
  const event = JSON.parse(text);
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'Agent') process.exit(0);
  const { stageResultOutput } = await import('../../../.harness/src/workflow/claude-stage-dispatch.mjs');
  const updatedToolOutput = await stageResultOutput(event);
  if (updatedToolOutput) await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } })}\n`, resolve));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
