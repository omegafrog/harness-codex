import { existsSync } from "node:fs";
const installed = new URL("../harness-runtime/src/eval/workspace-preflight.mjs", import.meta.url);
const source = new URL("../../src/eval/workspace-preflight.mjs", import.meta.url);
export const { inspectWorkspace } = await import(existsSync(installed) ? installed.href : source.href);
