#!/usr/bin/env node
// HARNESS_HOOK_TIMING=1 records this hook's duration; the hook itself is loaded after the timer starts. A measurement
// that cannot start (module missing or failing) never affects the hook.
await import('../../.harness/src/observability/hook-timing.mjs').then((module) => module.startHookTiming('fresh-agent'), () => null);
const { runFreshAgentHook } = await import('../../.harness/scripts/harness-fresh-agent.mjs');

await runFreshAgentHook();
