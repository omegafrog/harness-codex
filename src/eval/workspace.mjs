import { cp, mkdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { EvalInconclusiveError } from "./errors.mjs";
import { ensureDir, isWithin } from "./util.mjs";

const execFileAsync = promisify(execFile);

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

function runGit(repoRoot, args) {
  return execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function safePlanPath(planId) {
  const value = String(planId || "");
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new TypeError(`Unsafe plan id: ${planId}`);
  return value;
}

function resourceKey(resource) {
  if (typeof resource === "string") return resource;
  if (!resource || typeof resource !== "object" || typeof resource.kind !== "string" || typeof resource.name !== "string") throw new TypeError("Resource must have kind and name");
  return `${resource.kind}:${resource.name}`;
}

function resourcesConflict(left, right) {
  const a = resourceKey(left);
  const b = resourceKey(right);
  if (a === b) return true;
  const [aKind, aName] = a.includes(":") ? a.split(/:(.*)/s) : ["filesystem", a];
  const [bKind, bName] = b.includes(":") ? b.split(/:(.*)/s) : ["filesystem", b];
  if (aKind !== bKind) return false;
  if (aKind !== "filesystem") return false;
  return aName.startsWith(`${bName}/`) || bName.startsWith(`${aName}/`);
}

export class ResourceGraph {
  constructor(plans = []) {
    this.plans = new Map(plans.map((plan) => [plan.id, { ...plan, resources: plan.resources || [] }]));
  }

  conflicts(planA, planB) {
    return (this.plans.get(planA)?.resources || []).some((left) => (this.plans.get(planB)?.resources || []).some((right) => resourcesConflict(left, right)));
  }

  canParallelize(planIds) {
    return planIds.every((planId, index) => planIds.slice(index + 1).every((other) => !this.conflicts(planId, other)));
  }
}

export function schedulePlans(plans, { completedPlanIds = [], fixedGroupBase = null } = {}) {
  const completed = new Set(completedPlanIds);
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const runnable = plans.filter((plan) => !completed.has(plan.id) && plan.status !== "completed" && (plan.dependencies || []).every((dependency) => completed.has(dependency)));
  if (runnable.length === 0) return { runnable: [], groups: [] };
  const graph = new ResourceGraph(runnable);
  if (runnable.length === 1) return { runnable: runnable.map((plan) => plan.id), groups: [{ type: "sequential", planIds: [runnable[0].id], workspace: "execution_line" }] };
  const parallel = [];
  const serialized = [];
  for (const plan of runnable) {
    if (graph.canParallelize([...parallel.map((item) => item.id), plan.id])) parallel.push(plan);
    else serialized.push(plan);
  }
  const groups = [];
  if (parallel.length >= 2) groups.push({ type: "parallel", planIds: parallel.map((plan) => plan.id), fixed_group_base: fixedGroupBase, workspace: "isolated_worktree" });
  for (const plan of serialized) groups.push({ type: "sequential", planIds: [plan.id], workspace: "execution_line" });
  if (groups.length === 0) groups.push({ type: "sequential", planIds: runnable.map((plan) => plan.id), workspace: "execution_line" });
  return { runnable: runnable.map((plan) => plan.id), groups, planById: byId };
}

export class WorktreeManager {
  constructor({ repoRoot, runtimeRoot, runGitCommand = runGit } = {}) {
    if (!repoRoot || !runtimeRoot) throw new TypeError("repoRoot and runtimeRoot are required");
    this.repoRoot = resolve(repoRoot);
    this.runtimeRoot = resolve(runtimeRoot);
    this.runGit = runGitCommand;
    this.groupBases = new Map();
    this.blockedPools = new Set();
  }

  async allocate({ planId, mode = "parallel", fixedGroupBase = null, executionLine = null, groupId = "default" }) {
    safePlanPath(planId);
    const base = (await this.runGit(this.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (mode !== "parallel") return { planId, mode: "sequential", workspace: resolve(executionLine || this.repoRoot), owned: false, baseSha: base, finalHeadSha: null, dirty: null };
    if (this.blockedPools.has(groupId)) throw new Error(`Worktree pool is blocked: ${groupId}`);
    if (!fixedGroupBase) throw new TypeError("fixedGroupBase is required for parallel worktree allocation");
    if (this.groupBases.has(groupId) && this.groupBases.get(groupId) !== fixedGroupBase) throw new Error(`Parallel group ${groupId} has inconsistent fixed base`);
    this.groupBases.set(groupId, fixedGroupBase);
    const workspace = join(this.runtimeRoot, "worktrees", safePlanPath(planId));
    await ensureDir(join(this.runtimeRoot, "worktrees"));
    await this.runGit(this.repoRoot, ["worktree", "add", "--detach", workspace, fixedGroupBase]);
    const allocatedBase = (await this.runGit(workspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (allocatedBase !== fixedGroupBase) throw new Error(`Worktree base mismatch: expected ${fixedGroupBase}, got ${allocatedBase}`);
    return { planId, mode: "parallel", workspace, owned: true, baseSha: allocatedBase, finalHeadSha: null, dirty: null, groupId, fixedGroupBase };
  }

  async observe(handle) {
    const finalHeadSha = (await this.runGit(handle.workspace, ["rev-parse", "HEAD"])).stdout.trim();
    const status = await this.runGit(handle.workspace, ["status", "--porcelain", "--untracked-files=all"]);
    return { ...handle, finalHeadSha, dirty: status.stdout.trim().length > 0, dirtyFiles: status.stdout.split("\n").filter(Boolean) };
  }

  async cleanup(handle, { evidencePersisted = false } = {}) {
    if (!handle.owned) return { ...handle, cleanup: { state: "passed", reason: null } };
    let observed;
    try {
      observed = await this.observe(handle);
    } catch (error) {
      this.blockedPools.add(handle.groupId);
      return { ...handle, cleanup: { state: "failed", reason: "worktree_leak", error: error.message } };
    }
    if (!evidencePersisted) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", reason: "worktree_leak", error: "Evidence was not persisted before cleanup" } };
    }
    if (observed.dirty) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", reason: "worktree_leak", error: "Dirty worktree is not removed implicitly" } };
    }
    try {
      await this.runGit(this.repoRoot, ["worktree", "remove", handle.workspace]);
      this.blockedPools.delete(handle.groupId);
      return { ...observed, cleanup: { state: "passed", reason: null } };
    } catch (error) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", reason: "worktree_leak", error: error.message } };
    }
  }

  isPoolBlocked(groupId) {
    return this.blockedPools.has(groupId);
  }
}
