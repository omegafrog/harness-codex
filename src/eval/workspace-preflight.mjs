import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function worktreePaths(listing) {
  return listing.split(/\n(?=worktree )/)
    .map((block) => block.split("\n")[0]?.slice("worktree ".length))
    .filter(Boolean);
}

export async function inspectWorkspace({ workspaceRoot, cwd = process.cwd() } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new TypeError("workspaceRoot is required");
  if (typeof cwd !== "string" || !cwd.trim()) throw new TypeError("cwd is required");

  let workspacePath;
  let actualCwd;
  try {
    [workspacePath, actualCwd] = await Promise.all([realpath(resolve(workspaceRoot)), realpath(resolve(cwd))]);
  } catch (error) {
    return {
      valid: false,
      reason: "workspace_path_unavailable",
      workspace_root: resolve(workspaceRoot),
      cwd: resolve(cwd),
      git_root: null,
      worktree_registered: false,
      error: error.message,
    };
  }
  if (workspacePath !== actualCwd) {
    return { valid: false, reason: "cwd_mismatch", workspace_root: workspacePath, cwd: actualCwd, git_root: null, worktree_registered: false };
  }

  let topLevel;
  let listing;
  try {
    const [{ stdout: topLevel }, { stdout: listing }, { stdout: gitDir }, { stdout: commonDir }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: actualCwd, encoding: "utf8" }),
      execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: actualCwd, encoding: "utf8" }),
      execFileAsync("git", ["rev-parse", "--absolute-git-dir"], { cwd: actualCwd, encoding: "utf8" }),
      execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: actualCwd, encoding: "utf8" }),
    ]);
    const isLinkedWorktree = await realpath(resolve(gitDir.trim())) !== await realpath(resolve(commonDir.trim()));
    const gitRoot = await realpath(resolve(topLevel.trim()));
    const registeredRoots = await Promise.all(worktreePaths(listing).map((path) => realpath(path).catch(() => resolve(path))));
    const worktreeRegistered = registeredRoots.includes(workspacePath);
    const valid = gitRoot === workspacePath && worktreeRegistered;
    return {
      valid,
      reason: valid ? null : gitRoot !== workspacePath ? "git_root_mismatch" : "worktree_not_registered",
      workspace_root: workspacePath,
      cwd: actualCwd,
      git_root: gitRoot,
      worktree_registered: worktreeRegistered,
      is_linked_worktree: isLinkedWorktree,
    };
  } catch (error) {
    return { valid: false, reason: "not_a_git_worktree", workspace_root: workspacePath, cwd: actualCwd, git_root: null, worktree_registered: false, error: error.message };
  }
}
