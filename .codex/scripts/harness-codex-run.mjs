#!/usr/bin/env node
// Legacy entry point retained for previously installed callers; new stages use native subagents.
await import('./harness-agent-run.mjs');
