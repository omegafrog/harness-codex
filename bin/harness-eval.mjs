#!/usr/bin/env node
import { runSuite } from "../src/eval/runner.mjs";

function parseArgs(argv) {
  const args = { command: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--suite") args.suite = argv[++index];
    else if (token === "--config") args.config = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--command") args.command = argv[++index]?.split(" ").filter(Boolean);
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token !== "run") throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.suite) {
      console.log("Usage: harness-eval run --suite <suite-id> [--config <path>] [--run-id <id>] [--command <executable args>]");
      process.exitCode = args.help ? 0 : 2;
    } else {
      const result = await runSuite({ suiteId: args.suite, configPath: args.config, runId: args.runId, commandOverride: args.command });
      console.log(JSON.stringify({ suite_id: result.suite_id, run_id: result.run_id, state: result.state, passed: result.passed, counts: result.counts, run_dir: result.run_dir }));
      process.exitCode = result.passed ? 0 : 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ state: "inconclusive", reason: error.reason || "harness_runner_crash", message: error.message }));
    process.exitCode = 2;
  }
}
