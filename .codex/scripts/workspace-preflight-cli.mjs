import { inspectWorkspace } from "./workspace-preflight-core.mjs";

export async function runWorkspacePreflightCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = { expectedRoot: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--expected-root" && argv[index + 1]) options.expectedRoot = argv[++index];
    else if (token === "--json") options.json = true;
    else throw new Error(`Unknown or incomplete argument: ${token}`);
  }
  if (!options.expectedRoot) throw new Error("Usage: harness-workspace-preflight.mjs --expected-root <absolute-worktree-root> [--json]");
  const result = await inspectWorkspace({ expectedRoot: options.expectedRoot, cwd });
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`workspace ${result.valid ? "ready" : "blocked"}: ${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
  return result;
}
