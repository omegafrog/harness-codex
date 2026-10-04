#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessConfig, resolvePortablePath } from "../src/eval/case-loader.mjs";
import { retryRuntimeEvidence } from "../src/eval/runtime-observer.mjs";
import { runSuite } from "../src/eval/runner.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const args = { command: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "run") { /* Keep the existing run command's parsed shape. */ }
    else if (token === "retry-evidence") args.command = token;
    else if (token === "--suite") args.suite = argv[++index];
    else if (token === "--config") args.config = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--case-id") args.caseId = argv[++index];
    else if (token === "--attempt") args.attempt = Number(argv[++index]);
    else if (token === "--retry-of") args.retryOf = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (args.command === "retry-evidence" ? (!args.runId || !args.caseId) : !args.suite)) {
      console.log("Usage: harness-eval run --suite <suite-id> [--config <path>] [--run-id <id>] [--attempt <number> --retry-of <run-id>]\n       harness-eval retry-evidence --run-id <run-id> --case-id <case-id> [--attempt <number>]");
      process.exitCode = args.help ? 0 : 2;
    } else if (args.command === "retry-evidence") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.runId || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.caseId || "")) {
        throw new Error("retry-evidence requires safe --run-id and --case-id values");
      }
      const attempt = Number.isInteger(args.attempt) && args.attempt > 0 ? args.attempt : 1;
      const config = await loadHarnessConfig(packageRoot, args.config || ".codex/harness.yaml");
      const runtimeRoot = resolvePortablePath(packageRoot, config.eval.runtime_path);
      const caseDir = attempt === 1
        ? join(runtimeRoot, args.runId, "cases", args.caseId)
        : join(runtimeRoot, args.runId, "cases", args.caseId, "attempts", String(attempt));
      const result = await retryRuntimeEvidence({ root: packageRoot, retryArtifactPath: join(caseDir, "runtime-evidence-retry.json") });
      console.log(JSON.stringify(result));
      process.exitCode = result.collected ? 0 : 1;
    } else {
      const result = await runSuite({ root: packageRoot, suiteId: args.suite, configPath: args.config, runId: args.runId, attempt: args.attempt, retryOf: args.retryOf });
      console.log(JSON.stringify({ suite_id: result.suite_id, run_id: result.run_id, state: result.state, passed: result.passed, counts: result.counts, run_dir: result.run_dir }));
      process.exitCode = result.passed ? 0 : 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ state: "inconclusive", reason: error.reason || "harness_runner_crash", message: error.message }));
    process.exitCode = 2;
  }
}
