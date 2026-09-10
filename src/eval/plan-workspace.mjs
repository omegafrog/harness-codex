import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureDir, isWithin } from "./util.mjs";

const execFileAsync = promisify(execFile);
let managerInstance = 0;

function runGit(repoRoot, args) {
  return execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function safePlanPath(planId) {
  const value = String(planId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new TypeError(`Unsafe plan id: ${planId}`);
  return value;
}

function safeGroupPath(groupId) {
  const value = String(groupId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new TypeError(`Unsafe group id: ${groupId}`);
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
  if (aKind !== bKind || aKind !== "filesystem") return false;
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
        const execution = settlement.status === "fulfilled" ? settlement.value : { state: "failed", evidencePersisted: false, error: settlement.reason?.message || String(settlement.reason) };
        const cleaned = await manager.cleanup(handle, { evidencePersisted: execution?.evidencePersisted === true });
        return { planId: handle.planId, execution, workspace: cleaned.workspace, baseSha: cleaned.baseSha, finalHeadSha: cleaned.finalHeadSha, dirty: cleaned.dirty, cleanup: cleaned.cleanup, finalCaseState: cleaned.cleanup.final_case_state || (cleaned.cleanup.state === "failed" ? "inconclusive" : null) };
      }));
      results.push(...completed);
    } else {
      for (const planId of group.planIds) {
        const plan = schedule.planById.get(planId);
        const handle = await manager.allocate({ planId, mode: "sequential", executionLine });
        let execution;
        try { execution = await runPlan(plan, handle); } catch (error) { execution = { state: "failed", evidencePersisted: false, error: error.message }; }
        let observed;
        let cleanup;
        try {
          observed = await manager.observe(handle);
          cleanup = observed.dirty ? { state: "failed", reason: "worktree_leak", final_case_state: "inconclusive" } : { state: "passed", reason: null, final_case_state: null };
        } catch (error) {
          cleanup = { state: "failed", reason: "worktree_leak", final_case_state: "inconclusive", error: error.message };
          observed = handle;
        }
        results.push({ planId, execution, workspace: observed.workspace, baseSha: observed.baseSha, finalHeadSha: observed.finalHeadSha, dirty: observed.dirty, cleanup, finalCaseState: cleanup.final_case_state || (cleanup.state === "failed" ? "inconclusive" : null) });
        if (cleanup.state === "failed") break;
      }
    }
  }
  return { schedule, results };
}

export class WorktreeManager {
  constructor({ repoRoot, runtimeRoot, runId = null, runGitCommand = runGit } = {}) {
    if (!repoRoot || !runtimeRoot) throw new TypeError("repoRoot and runtimeRoot are required");
    this.repoRoot = resolve(repoRoot);
    this.runtimeRoot = resolve(runtimeRoot);
    if (isWithin(this.repoRoot, this.runtimeRoot)) throw new TypeError("Worktree runtime root must remain outside repository root");
    this.runtimeNamespace = safeGroupPath(runId || `manager-${process.pid}-${++managerInstance}`);
    this.runGit = runGitCommand;
    this.groupBases = new Map();
    this.blockedPools = new Set();
    this.poolHandles = new Map();
  }

  async allocate({ planId, mode = "parallel", fixedGroupBase = null, executionLine = null, groupId = "default" }) {
    safePlanPath(planId);
    const sequentialWorkspace = resolve(executionLine || this.repoRoot);
    const base = (await this.runGit(mode === "parallel" ? this.repoRoot : sequentialWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (mode !== "parallel") return { planId, mode: "sequential", workspace: sequentialWorkspace, owned: false, baseSha: base, finalHeadSha: null, dirty: null };
    if (this.blockedPools.has(groupId)) throw new Error(`Worktree pool is blocked: ${groupId}`);
    if (!fixedGroupBase) throw new TypeError("fixedGroupBase is required for parallel worktree allocation");
    if (this.groupBases.has(groupId) && this.groupBases.get(groupId) !== fixedGroupBase) throw new Error(`Parallel group ${groupId} has inconsistent fixed base`);
    const workspace = join(this.runtimeRoot, "worktrees", this.runtimeNamespace, safeGroupPath(groupId), safePlanPath(planId));
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
          } else error.worktree_leak = true;
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

  async verify(handle, { fixedGroupBase = handle.fixedGroupBase } = {}) {
    if (!handle?.owned || handle.mode !== "parallel" || !handle.workspace || !fixedGroupBase) return { valid: false, reason: "invalid_worktree_handle" };
    const workspace = resolve(handle.workspace);
    if (isWithin(this.repoRoot, workspace)) return { valid: false, reason: "workspace_inside_repository" };
    const observed = await this.observe(handle);
    if (observed.baseSha !== fixedGroupBase) return { valid: false, reason: "worktree_base_mismatch", observed };
    const listing = await this.runGit(this.repoRoot, ["worktree", "list", "--porcelain"]);
    const block = listing.stdout.split(/\n(?=worktree )/).find((entry) => entry.split("\n")[0] === `worktree ${workspace}`);
    const headLine = block?.split("\n").find((line) => line.startsWith("HEAD "));
    const actualHead = headLine?.slice("HEAD ".length).trim();
    return {
      valid: Boolean(block) && actualHead === fixedGroupBase,
      workspace,
      fixed_group_base: fixedGroupBase,
      actual_head: actualHead || null,
      reason: block ? (actualHead === fixedGroupBase ? null : "worktree_head_mismatch") : "worktree_not_registered",
    };
  }

  async cleanup(handle, { evidencePersisted = false } = {}) {
    if (!handle.owned) return { ...handle, cleanup: { state: "passed", reason: null } };
    let observed;
    try { observed = await this.observe(handle); } catch (error) {
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
      if (!handles?.size) { this.blockedPools.delete(handle.groupId); this.poolHandles.delete(handle.groupId); }
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
