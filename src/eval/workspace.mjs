import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EvalInconclusiveError } from "./errors.mjs";
import { ensureDir, isWithin } from "./util.mjs";

export async function provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  const workspace = join(caseDir, "workspace");
  await ensureDir(caseDir);
  await mkdir(workspace, { recursive: true });
  if (fixturePath) {
    try {
      await stat(fixturePath);
      await cp(fixturePath, workspace, { recursive: true, force: false, errorOnExist: false });
    } catch (error) {
      throw new EvalInconclusiveError("corrupted_fixture", `Unable to provision fixture: ${fixturePath}`, { cause: error });
    }
  }
  return { caseDir, workspace: resolve(workspace), allowedWriteScope: resolve(workspace), root };
}

export function assertWorkspaceTarget(workspace, target) {
  if (!target || typeof target !== "string") return true;
  if (!target.startsWith("/") && !target.startsWith(".") && !target.includes("/")) return true;
  const resolvedTarget = target.startsWith("/") ? target : resolve(workspace, target);
  if (!isWithin(workspace, resolvedTarget)) throw new EvalInconclusiveError("workspace_escape", `Target escapes case workspace: ${target}`, { workspace, target });
  return true;
}

export async function cleanupCaseWorkspace(handle) {
  if (!handle?.workspace) throw new TypeError("workspace handle is required");
  try {
    await rm(handle.workspace, { recursive: true, force: false });
    return { state: "passed", reason: null };
  } catch (error) {
    return { state: "failed", reason: "workspace_cleanup_failure", error };
  }
}
