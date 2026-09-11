import { access, cp, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { EvalInconclusiveError } from "./errors.mjs";
import { ensureDir, isWithin } from "./util.mjs";

const execFileAsync = promisify(execFile);
const TARGET_PATH_FIELDS = ["path", "file", "file_path", "workspace_path", "absolute_path"];

export function workspaceTargetCandidates(target) {
  if (typeof target === "string") return [target];
  if (!target || typeof target !== "object" || Array.isArray(target)) return [];
  return TARGET_PATH_FIELDS.filter((field) => typeof target[field] === "string").map((field) => target[field]);
}

export function resolveWorkspaceTarget(workspace, targetPath) {
  const foreignWindowsAbsolute = process.platform !== "win32" && win32.isAbsolute(targetPath);
  if (foreignWindowsAbsolute) return null;
  const normalized = process.platform === "win32" ? targetPath.replaceAll("/", "\\") : targetPath.replaceAll("\\", "/");
  return isAbsolute(normalized) || posix.isAbsolute(normalized) || win32.isAbsolute(normalized)
    ? normalized
    : resolve(workspace, normalized);
}

export function workspaceTargetEscapes(workspace, targetPath) {
  const resolvedTarget = resolveWorkspaceTarget(workspace, targetPath);
  return !resolvedTarget || !isWithin(workspace, resolvedTarget);
}

export async function provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  const workspace = join(caseDir, "workspace");
  const stagingWorkspace = join(caseDir, `.workspace-staging-${process.pid}-${Date.now()}`);
  const isolatedHome = join(stagingWorkspace, ".eval-home");
  const isolatedCodexHome = join(stagingWorkspace, ".eval-codex-home");
  const isolatedTmp = join(stagingWorkspace, ".eval-tmp");
  await ensureDir(caseDir);
  await mkdir(stagingWorkspace, { recursive: false });
  try {
    await copyHarnessRuntime({ root, workspace: stagingWorkspace });
    if (fixturePath) {
      await stat(fixturePath);
      await cp(fixturePath, stagingWorkspace, { recursive: true, force: false, errorOnExist: false });
    }
    await execFileAsync("git", ["init", "-q", stagingWorkspace]);
    await execFileAsync("git", ["-C", stagingWorkspace, "config", "user.email", "eval@example.invalid"]);
    await execFileAsync("git", ["-C", stagingWorkspace, "config", "user.name", "Eval Runner"]);
    await writeFile(join(stagingWorkspace, ".gitignore"), ".eval-home/\n.eval-codex-home/\n.eval-tmp/\n.eval-output/\n", "utf8");
    await execFileAsync("git", ["-C", stagingWorkspace, "add", "--all"]);
    await execFileAsync("git", ["-C", stagingWorkspace, "commit", "--allow-empty", "-q", "-m", "eval fixture baseline"]);
    await Promise.all([ensureDir(isolatedHome), ensureDir(isolatedCodexHome), ensureDir(isolatedTmp)]);
    try {
      await access(workspace);
      throw new EvalInconclusiveError("environment_provisioning_failure", `Case workspace already exists: ${workspace}`);
    } catch (error) {
      if (error instanceof EvalInconclusiveError) throw error;
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stagingWorkspace, workspace);
  } catch (error) {
    const classified = error.code === "ENOENT" && fixturePath
      ? new EvalInconclusiveError("corrupted_fixture", `Unable to provision fixture: ${fixturePath}`, { cause: error })
      : error;
    try { await rm(stagingWorkspace, { recursive: true, force: false }); } catch (cleanupError) {
      throw new EvalInconclusiveError("workspace_cleanup_failure", `Unable to clean failed case workspace: ${stagingWorkspace}`, { cause: classified, cleanupError });
    }
    if (classified instanceof EvalInconclusiveError) throw classified;
    throw new EvalInconclusiveError("environment_provisioning_failure", `Unable to initialize isolated case repository: ${workspace}`, { cause: classified });
  }
  return {
    caseDir,
    workspace: resolve(workspace),
    allowedWriteScope: resolve(workspace),
    isolatedHome: join(workspace, ".eval-home"),
    isolatedCodexHome: join(workspace, ".eval-codex-home"),
    isolatedTmp: join(workspace, ".eval-tmp"),
    root,
  };
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
  const targetPaths = workspaceTargetCandidates(target);
  if (targetPaths.length === 0) return true;
  const workspaceReal = await realpath(workspace);
  for (const targetPath of targetPaths) {
    const resolvedTarget = resolveWorkspaceTarget(workspace, targetPath);
    if (!resolvedTarget || !isWithin(workspace, resolvedTarget)) throw new EvalInconclusiveError("workspace_escape", `Target escapes case workspace: ${targetPath}`, { workspace, target });
    let probe = resolvedTarget;
    while (true) {
      try {
        if (!isWithin(workspaceReal, await realpath(probe))) throw new EvalInconclusiveError("workspace_escape", `Target resolves outside case workspace: ${targetPath}`, { workspace, target });
        break;
      } catch (error) {
        if (error instanceof EvalInconclusiveError) throw error;
        if (error.code !== "ENOENT" || probe === workspace) break;
        probe = dirname(probe);
      }
    }
  }
  return true;
}

export async function cleanupCaseWorkspace(handle, { evidencePersisted = false } = {}) {
  if (!handle?.workspace) throw new TypeError("workspace handle is required");
  if (!evidencePersisted) {
    return {
      state: "failed",
      reason: "workspace_cleanup_failure",
      final_case_state: "inconclusive",
      dirty: null,
      workspace: handle.workspace,
      error: "Evidence was not persisted before cleanup",
    };
  }
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
