import { access, cp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { EvalInconclusiveError } from "./errors.mjs";
import { ensureDir, isWithin } from "./util.mjs";

const execFileAsync = promisify(execFile);

export async function provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  const workspace = join(caseDir, "workspace");
  const isolatedHome = join(workspace, ".eval-home");
  const isolatedCodexHome = join(workspace, ".eval-codex-home");
  const isolatedTmp = join(workspace, ".eval-tmp");
  await ensureDir(caseDir);
  await mkdir(workspace, { recursive: true });
  try {
    await copyHarnessRuntime({ root, workspace });
    if (fixturePath) {
      await stat(fixturePath);
      await cp(fixturePath, workspace, { recursive: true, force: false, errorOnExist: false });
    }
    await execFileAsync("git", ["init", "-q", workspace]);
    await execFileAsync("git", ["-C", workspace, "config", "user.email", "eval@example.invalid"]);
    await execFileAsync("git", ["-C", workspace, "config", "user.name", "Eval Runner"]);
    await writeFile(join(workspace, ".gitignore"), ".eval-home/\n.eval-codex-home/\n.eval-tmp/\n", "utf8");
    await execFileAsync("git", ["-C", workspace, "add", "--all"]);
    await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-q", "-m", "eval fixture baseline"]);
    await Promise.all([ensureDir(isolatedHome), ensureDir(isolatedCodexHome), ensureDir(isolatedTmp)]);
  } catch (error) {
    const classified = error.code === "ENOENT" && fixturePath
      ? new EvalInconclusiveError("corrupted_fixture", `Unable to provision fixture: ${fixturePath}`, { cause: error })
      : error;
    try { await rm(workspace, { recursive: true, force: false }); } catch (cleanupError) {
      throw new EvalInconclusiveError("workspace_cleanup_failure", `Unable to clean failed case workspace: ${workspace}`, { cause: classified, cleanupError });
    }
    if (classified instanceof EvalInconclusiveError) throw classified;
    throw new EvalInconclusiveError("environment_provisioning_failure", `Unable to initialize isolated case repository: ${workspace}`, { cause: classified });
  }
  return { caseDir, workspace: resolve(workspace), allowedWriteScope: resolve(workspace), isolatedHome, isolatedCodexHome, isolatedTmp, root };
}

async function copyHarnessRuntime({ root, workspace }) {
  const paths = [
    "AGENTS.md",
    "CONTEXT.md",
    "CONTEXT-MAP.md",
    ".codex/openai.yaml",
    ".codex/repository-conventions.md",
    ".codex/harness.yaml",
  ];
  for (const relativePath of paths) {
    const source = resolve(root, relativePath);
    try { await access(source); } catch { continue; }
    const destination = join(workspace, relativePath);
    await ensureDir(dirname(destination));
    await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
  }
  for (const directory of [".codex/agents", ".codex/skills", "docs/agents", "docs/specs/496"]) {
    const source = resolve(root, directory);
    try { await access(source); } catch { continue; }
    await cp(source, join(workspace, directory), { recursive: true, force: false, errorOnExist: false });
  }
}

export async function assertWorkspaceTarget(workspace, target) {
  if (!target || typeof target !== "string") return true;
  if (!target.startsWith("/") && !target.startsWith(".") && !target.includes("/")) return true;
  const resolvedTarget = target.startsWith("/") ? target : resolve(workspace, target);
  if (!isWithin(workspace, resolvedTarget)) throw new EvalInconclusiveError("workspace_escape", `Target escapes case workspace: ${target}`, { workspace, target });
  const workspaceReal = await realpath(workspace);
  let probe = resolvedTarget;
  while (true) {
    try {
      if (!isWithin(workspaceReal, await realpath(probe))) throw new EvalInconclusiveError("workspace_escape", `Target resolves outside case workspace: ${target}`, { workspace, target });
      break;
    } catch (error) {
      if (error instanceof EvalInconclusiveError) throw error;
      if (error.code !== "ENOENT" || probe === workspace) break;
      probe = dirname(probe);
    }
  }
  return true;
}

export async function cleanupCaseWorkspace(handle) {
  if (!handle?.workspace) throw new TypeError("workspace handle is required");
  try {
    const status = await execFileAsync("git", ["-C", handle.workspace, "status", "--porcelain", "--untracked-files=all"]);
    const dirtyFiles = status.stdout.split("\n").filter(Boolean);
    if (dirtyFiles.length > 0) {
      return { state: "failed", reason: "worktree_leak", final_case_state: "inconclusive", dirty: true, dirty_files: dirtyFiles, workspace: handle.workspace };
    }
    await rm(handle.workspace, { recursive: true, force: false });
    return { state: "passed", reason: null, dirty: false, workspace: handle.workspace };
  } catch (error) {
    return { state: "failed", reason: "workspace_cleanup_failure", final_case_state: "inconclusive", workspace: handle.workspace, error: error.message };
  }
}
