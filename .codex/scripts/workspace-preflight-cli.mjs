import { existsSync } from "node:fs";
import { inspectWorkspace } from "./workspace-preflight-core.mjs";

export async function runWorkspacePreflightCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = { expectedRoot: null, json: false, forImplementation: false, deferTrackerSync: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--expected-root" && argv[index + 1]) options.expectedRoot = argv[++index];
    else if (token === "--json") options.json = true;
    else if (token === "--for-implementation") options.forImplementation = true;
    else if (token === "--defer-tracker-sync") options.deferTrackerSync = true;
    else throw new Error(`Unknown or incomplete argument: ${token}`);
  }
  if (!options.expectedRoot || (options.deferTrackerSync && options.forImplementation)) throw new Error("Usage: harness-workspace-preflight.mjs --expected-root <absolute-worktree-root> [--for-implementation | --defer-tracker-sync] [--json]");
  const result = await inspectWorkspace({ expectedRoot: options.expectedRoot, cwd });
  if (result.valid && options.deferTrackerSync) result.tracker_sync = { status: "deferred", reason: "to_ticket_batch_publish" };
  if (result.valid && !options.deferTrackerSync) {
    const installed = new URL("../harness-runtime/src/tracker/lifecycle.mjs", import.meta.url);
    const source = new URL("../../src/tracker/lifecycle.mjs", import.meta.url);
    const { inspectTrackerSync } = await import(existsSync(installed) ? installed.href : source.href);
    result.tracker_sync = await inspectTrackerSync({ workspace_root: result.expected_root });
    if (result.tracker_sync.status !== "pass") { result.valid = false; result.reason = result.tracker_sync.reason; }
  }
  if (result.valid && options.forImplementation) {
    const installed = new URL('../harness-runtime/src/workflow/project-readiness.mjs', import.meta.url);
    const source = new URL('../../src/workflow/project-readiness.mjs', import.meta.url);
    const { inspectProjectReadiness } = await import(existsSync(installed) ? installed.href : source.href);
    result.project_readiness = await inspectProjectReadiness({ workspace_root: result.expected_root, deferContractSync: true });
    if (result.project_readiness.contract_sync?.status === "deferred") result.contract_sync = result.project_readiness.contract_sync;
    if (result.project_readiness.status !== 'pass') { result.valid = false; result.reason = result.project_readiness.reason; }
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`workspace ${result.valid ? "ready" : "blocked"}: ${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
  return result;
}
