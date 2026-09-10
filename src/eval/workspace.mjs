import { access, cp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { EvalInconclusiveError } from "./errors.mjs";
import { ensureDir, isWithin } from "./util.mjs";

const execFileAsync = promisify(execFile);

export async function provisionCaseWorkspace({ runDir, caseSpec, root, fixturePath = null }) {
  const caseDir = join(runDir, "cases", caseSpec.id);
  const workspace = join(caseDir, "workspace");
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
    await execFileAsync("git", ["-C", workspace, "add", "--all"]);
    await execFileAsync("git", ["-C", workspace, "commit", "--allow-empty", "-q", "-m", "eval fixture baseline"]);
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
  return { caseDir, workspace: resolve(workspace), allowedWriteScope: resolve(workspace), root };
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
    this.plans = new Map(plans.map((plan) => [plan.id, { ...plan, resources: Array.isArray(plan.resources) ? plan.resources : null }]));
  }

  conflicts(planA, planB) {
    const leftResources = this.plans.get(planA)?.resources;
    const rightResources = this.plans.get(planB)?.resources;
    if (!leftResources?.length || !rightResources?.length) return true;
    return leftResources.some((left) => rightResources.some((right) => resourcesConflict(left, right)));
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
  const knownResources = runnable.every((plan) => Array.isArray(plan.resources) && plan.resources.length > 0);
  const canCreateParallelGroup = knownResources && fixedGroupBase && graph.canParallelize(runnable.map((plan) => plan.id));
  const groups = canCreateParallelGroup
    ? [{ type: "parallel", planIds: runnable.map((plan) => plan.id), fixed_group_base: fixedGroupBase, workspace: "isolated_worktree" }]
    : [{ type: "sequential", planIds: runnable.map((plan) => plan.id), workspace: "execution_line", reason: !knownResources ? "resource_independence_unknown" : "missing_fixed_group_base_or_shared_resource" }];
  return { runnable: runnable.map((plan) => plan.id), groups, planById: byId };
}

export async function runScheduledPlanGroup({ plans, completedPlanIds = [], fixedGroupBase = null, executionLine, manager, runPlan }) {
  if (!manager || typeof runPlan !== "function") throw new TypeError("manager and runPlan are required");
  const schedule = schedulePlans(plans, { completedPlanIds, fixedGroupBase });
  const results = [];
  for (const group of schedule.groups) {
    if (group.type === "parallel") {
      const allocations = await Promise.allSettled(group.planIds.map((planId) => manager.allocate({ planId, mode: "parallel", fixedGroupBase: group.fixed_group_base, groupId: `parallel-${group.fixed_group_base}` })));
      const allocationFailure = allocations.find((allocation) => allocation.status === "rejected");
      if (allocationFailure) {
        await Promise.all(allocations.filter((allocation) => allocation.status === "fulfilled").map((allocation) => manager.cleanup(allocation.value, { evidencePersisted: false })));
        throw allocationFailure.reason;
      }
      const handles = allocations.map((allocation) => allocation.value);
      const executions = await Promise.allSettled(handles.map((handle) => runPlan(schedule.planById.get(handle.planId), handle)));
      const completed = await Promise.all(handles.map(async (handle, index) => {
        const settlement = executions[index];
        const execution = settlement.status === "fulfilled"
          ? settlement.value
          : { state: "failed", evidencePersisted: false, error: settlement.reason?.message || String(settlement.reason) };
        const cleaned = await manager.cleanup(handle, { evidencePersisted: execution?.evidencePersisted === true });
        return { planId: handle.planId, execution, workspace: cleaned.workspace, baseSha: cleaned.baseSha, finalHeadSha: cleaned.finalHeadSha, dirty: cleaned.dirty, cleanup: cleaned.cleanup, finalCaseState: cleaned.cleanup.final_case_state || (cleaned.cleanup.state === "failed" ? "inconclusive" : null) };
      }));
      results.push(...completed);
    } else {
      for (const planId of group.planIds) {
        const plan = schedule.planById.get(planId);
        const handle = await manager.allocate({ planId, mode: "sequential", executionLine });
        const execution = await runPlan(plan, handle);
        results.push({ planId, execution, workspace: handle.workspace, baseSha: handle.baseSha, finalHeadSha: null, dirty: null, cleanup: { state: "passed", reason: null }, finalCaseState: null });
      }
    }
  }
  return { schedule, results };
}

export class WorktreeManager {
  constructor({ repoRoot, runtimeRoot, runGitCommand = runGit } = {}) {
    if (!repoRoot || !runtimeRoot) throw new TypeError("repoRoot and runtimeRoot are required");
    this.repoRoot = resolve(repoRoot);
    this.runtimeRoot = resolve(runtimeRoot);
    this.runGit = runGitCommand;
    this.groupBases = new Map();
    this.blockedPools = new Set();
    this.poolHandles = new Map();
  }

  async allocate({ planId, mode = "parallel", fixedGroupBase = null, executionLine = null, groupId = "default" }) {
    safePlanPath(planId);
    const base = (await this.runGit(this.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (mode !== "parallel") return { planId, mode: "sequential", workspace: resolve(executionLine || this.repoRoot), owned: false, baseSha: base, finalHeadSha: null, dirty: null };
    if (this.blockedPools.has(groupId)) throw new Error(`Worktree pool is blocked: ${groupId}`);
    if (!fixedGroupBase) throw new TypeError("fixedGroupBase is required for parallel worktree allocation");
    if (this.groupBases.has(groupId) && this.groupBases.get(groupId) !== fixedGroupBase) throw new Error(`Parallel group ${groupId} has inconsistent fixed base`);
    const workspace = join(this.runtimeRoot, "worktrees", safePlanPath(planId));
    await ensureDir(join(this.runtimeRoot, "worktrees"));
    let allocatedBase;
    let added = false;
    try {
      await this.runGit(this.repoRoot, ["worktree", "add", "--detach", workspace, fixedGroupBase]);
      added = true;
      allocatedBase = (await this.runGit(workspace, ["rev-parse", "HEAD"])).stdout.trim();
      if (allocatedBase !== fixedGroupBase) throw new Error(`Worktree base mismatch: expected ${fixedGroupBase}, got ${allocatedBase}`);
    } catch (error) {
      this.blockedPools.add(groupId);
      if (!this.poolHandles.has(groupId)) this.poolHandles.set(groupId, new Set());
      if (added) {
        const handle = { planId, mode: "parallel", workspace, owned: true, baseSha: allocatedBase || fixedGroupBase, finalHeadSha: null, dirty: null, groupId, fixedGroupBase };
        this.poolHandles.get(groupId).add(workspace);
        try {
          const observed = await this.observe(handle);
          error.worktree_evidence = observed;
          if (!observed.dirty) {
            await this.runGit(this.repoRoot, ["worktree", "remove", workspace]);
            this.poolHandles.get(groupId).delete(workspace);
          } else {
            error.worktree_leak = true;
          }
        } catch (cleanupError) {
          error.worktree_leak = true;
          error.cleanup_error = cleanupError.message;
        }
      }
      throw error;
    }
    this.groupBases.set(groupId, fixedGroupBase);
    if (!this.poolHandles.has(groupId)) this.poolHandles.set(groupId, new Set());
    this.poolHandles.get(groupId).add(workspace);
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
      return { ...handle, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "worktree_leak", error: error.message } };
    }
    if (!evidencePersisted) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "worktree_leak", error: "Evidence was not persisted before cleanup" } };
    }
    if (observed.dirty) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "worktree_leak", error: "Dirty worktree is not removed implicitly" } };
    }
    try {
      await this.runGit(this.repoRoot, ["worktree", "remove", handle.workspace]);
      const handles = this.poolHandles.get(handle.groupId);
      handles?.delete(handle.workspace);
      if (!handles?.size) {
        this.blockedPools.delete(handle.groupId);
        this.poolHandles.delete(handle.groupId);
      }
      return { ...observed, cleanup: { state: "passed", final_case_state: null, reason: null } };
    } catch (error) {
      this.blockedPools.add(handle.groupId);
      return { ...observed, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "worktree_leak", error: error.message } };
    }
  }

  isPoolBlocked(groupId) {
    return this.blockedPools.has(groupId);
  }
}
