#!/usr/bin/env node
import { runWorkspacePreflightCli } from "../.codex/scripts/workspace-preflight-cli.mjs";

try {
  await runWorkspacePreflightCli();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
