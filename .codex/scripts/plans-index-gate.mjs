import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const installed = new URL("../harness-runtime/src/gates/plans-index.mjs", import.meta.url);
const source = new URL("../../src/gates/plans-index.mjs", import.meta.url);
export const { inspectPlansIndex } = await import(existsSync(installed) ? installed.href : source.href);

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--workspace-root") values.workspace_root = argv[++index];
    else if (key === "--plan-set-id") values.plan_set_id = argv[++index];
    else throw new Error(`Unknown argument: ${key}`);
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const verdict = inspectPlansIndex(readArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    if (verdict.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
