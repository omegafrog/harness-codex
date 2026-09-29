import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLAN_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function inspectPlansIndex({ workspace_root: workspaceRoot, plan_set_id: planSetId } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()
    || typeof planSetId !== "string" || !PLAN_SET_ID.test(planSetId)) {
    return { status: "blocked", rule_id: "plans_index", reason: "plans_index_evidence_incomplete", evidence_path: null, violations: [] };
  }
  const path = join(resolve(workspaceRoot), "docs", "plans", planSetId, "plans.md");
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size === 0) {
      return { status: "fail", rule_id: "plans_index", reason: "plans_index_missing_or_empty", evidence_path: path, violations: ["plans_index"] };
    }
    return { status: "pass", rule_id: "plans_index", reason: "plans_index_present", evidence_path: path, violations: [] };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { status: "fail", rule_id: "plans_index", reason: "plans_index_missing", evidence_path: path, violations: ["plans_index"] };
    }
    throw error;
  }
}

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
