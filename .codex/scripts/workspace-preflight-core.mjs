const installed = new URL("../../.harness/src/eval/workspace-preflight.mjs", import.meta.url);
export const { inspectWorkspace } = await import(installed.href);
