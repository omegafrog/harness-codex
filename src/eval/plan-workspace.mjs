import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureDir, isWithin } from "./util.mjs";
import { parseYaml } from "./yaml.mjs";
import { compareKnowledgeMerge } from "../knowledge/merge.mjs";

const execFileAsync = promisify(execFile);
let managerInstance = 0;
let branchInstance = 0;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KNOWLEDGE_FILE = /^knowledge\/(sources|claims|principles|evidence)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yaml$/;
const KNOWLEDGE_KIND = { sources: "source", claims: "claim", principles: "principle", evidence: "evidence" };

function runGit(repoRoot, args) {
  return execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

async function changedKnowledgePaths(root, base, head) {
  const { stdout } = await runGit(root, ["diff", "--name-only", `${base}...${head}`, "--", "knowledge/sources", "knowledge/claims", "knowledge/principles", "knowledge/evidence"]);
  return stdout.trim().split("\n").filter((path) => KNOWLEDGE_FILE.test(path));
}

async function readKnowledgeAt(root, revision, path) {
  try {
    const { stdout } = await runGit(root, ["show", `${revision}:${path}`]);
    return parseYaml(stdout);
  } catch (error) {
    if (/does not exist in|exists on disk, but not in|Path .* exists on disk/.test(error.stderr || "")) return null;
    throw error;
  }
}

async function findKnowledgeMergeConflicts(root, { base, source, target }) {
  const [sourcePaths, targetPaths] = await Promise.all([
    changedKnowledgePaths(root, base, source),
    changedKnowledgePaths(root, base, target),
  ]);
  const targetPathSet = new Set(targetPaths);
  const collisions = [];
  for (const path of sourcePaths.filter((candidate) => targetPathSet.has(candidate)).sort()) {
    const [, directory] = path.match(KNOWLEDGE_FILE);
    const [baseObject, sourceObject, targetObject] = await Promise.all([
      readKnowledgeAt(root, base, path),
      readKnowledgeAt(root, source, path),
      readKnowledgeAt(root, target, path),
    ]);
    for (const conflict of compareKnowledgeMerge(baseObject, sourceObject, targetObject)) {
      collisions.push({ id: conflict.id, object_kind: KNOWLEDGE_KIND[directory], fields: conflict.fields });
    }
  }
  return collisions;
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

export function buildParallelGroupId(planIds, { runId = null, schedulingWave = 0, groupIndex = 0 } = {}) {
  if (!Array.isArray(planIds) || planIds.length < 2 || planIds.some((planId) => typeof planId !== "string" || !SAFE_ID.test(planId))) throw new TypeError("parallel group plan ids must be safe identifiers");
  if (typeof runId !== "string" || !SAFE_ID.test(runId)) throw new TypeError("runId must be a safe identifier");
  if (!Number.isInteger(schedulingWave) || schedulingWave < 0) throw new TypeError("schedulingWave must be a non-negative integer");
  if (!Number.isInteger(groupIndex) || groupIndex < 0) throw new TypeError("groupIndex must be a non-negative integer");
  const encodedPlanIds = planIds.map((planId) => `${planId.length}_${planId}`).join("_");
  return `parallel-${runId}-wave-${schedulingWave}-group-${groupIndex}-${encodedPlanIds}`;
}

function independentBatches(plans, graph) {
  const batches = [];
  for (const plan of plans) {
    const batch = batches.find((candidate) => candidate.every((other) => !graph.conflicts(plan.id, other.id)));
    if (batch) batch.push(plan);
    else batches.push([plan]);
  }
  return batches;
}

export function schedulePlans(plans, { completedPlanIds = [], fixedGroupBase = null, runId = null, schedulingWave = 0 } = {}) {
  const completed = new Set(completedPlanIds);
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const runnable = plans.filter((plan) => !completed.has(plan.id) && plan.status !== "completed" && (plan.dependencies || []).every((dependency) => completed.has(dependency)));
  if (runnable.length === 0) return { runnable: [], groups: [] };
  const graph = new ResourceGraph(runnable);
  if (runnable.length === 1) return { runnable: runnable.map((plan) => plan.id), groups: [{ type: "sequential", planIds: [runnable[0].id], workspace: "execution_line" }] };
  const knownResources = runnable.every((plan) => Array.isArray(plan.resources) && plan.resources.length > 0);
  const groups = !knownResources || !fixedGroupBase
    ? [{ type: "sequential", planIds: runnable.map((plan) => plan.id), workspace: "execution_line", reason: !knownResources ? "resource_independence_unknown" : "missing_fixed_group_base_or_shared_resource" }]
    : independentBatches(runnable, graph).map((batch, groupIndex) => {
      const planIds = batch.map((plan) => plan.id);
      if (batch.length > 1) return { type: "parallel", planIds, group_id: buildParallelGroupId(planIds, { runId, schedulingWave, groupIndex }), fixed_group_base: fixedGroupBase, workspace: "isolated_worktree" };
      const conflicted = runnable.some((plan) => plan.id !== batch[0].id && graph.conflicts(plan.id, batch[0].id));
      return { type: "sequential", planIds, workspace: "execution_line", ...(conflicted ? { reason: "shared_resource_conflict" } : {}) };
    });
  return { runnable: runnable.map((plan) => plan.id), groups, planById: byId };
}

export async function runScheduledPlanGroup({ plans, completedPlanIds = [], fixedGroupBase = null, executionLine, manager, runPlan, runId = null, schedulingWave = 0 }) {
  if (!manager || typeof runPlan !== "function") throw new TypeError("manager and runPlan are required");
  const schedule = schedulePlans(plans, { completedPlanIds, fixedGroupBase, runId, schedulingWave });
  const results = [];
  for (const group of schedule.groups) {
    if (group.type === "parallel") {
      const allocations = await Promise.allSettled(group.planIds.map((planId) => manager.allocate({ planId, mode: "parallel", fixedGroupBase: group.fixed_group_base, groupId: group.group_id })));
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
        return { planId: handle.planId, groupId: handle.groupId, execution, workspace: cleaned.workspace, baseSha: cleaned.baseSha, finalHeadSha: cleaned.finalHeadSha, dirty: cleaned.dirty, cleanup: cleaned.cleanup, finalCaseState: cleaned.cleanup.final_case_state || (cleaned.cleanup.state === "failed" ? "inconclusive" : null) };
      }));
      results.push(...completed);
    } else {
      for (const planId of group.planIds) {
        const plan = schedule.planById.get(planId);
        const handle = await manager.allocate({ planId, mode: "sequential", executionLine });
        let execution;
        try { execution = await runPlan(plan, handle); } catch (error) { execution = { state: "failed", evidencePersisted: false, error: error.message }; }
        const cleaned = await manager.cleanup(handle, { evidencePersisted: execution?.evidencePersisted === true });
        results.push({ planId, execution, workspace: cleaned.workspace, baseSha: cleaned.baseSha, finalHeadSha: cleaned.finalHeadSha, dirty: cleaned.dirty, cleanup: cleaned.cleanup, finalCaseState: cleaned.cleanup.final_case_state || (cleaned.cleanup.state === "failed" ? "inconclusive" : null) });
        if (cleaned.cleanup.state === "failed") break;
      }
    }
  }
  return { schedule, results };
}

export async function integrateParallelPlanBranches({ manager, handles, targetWorkspace, expectedTargetBranch, order = null } = {}) {
  if (!manager || typeof manager.integrate !== "function") throw new TypeError("manager with integrate() is required");
  if (!Array.isArray(handles) || handles.some((handle) => !handle?.owned || handle.mode !== "parallel")) throw new TypeError("parallel worktree handles are required");
  const byPlanId = new Map(handles.map((handle) => [handle.planId, handle]));
  if (byPlanId.size !== handles.length) throw new TypeError("parallel worktree plan ids must be unique");
  const planOrder = order || [...byPlanId.keys()].sort();
  if (planOrder.length !== handles.length || new Set(planOrder).size !== handles.length || planOrder.some((planId) => !byPlanId.has(planId))) {
    throw new TypeError("integration order must list every parallel plan exactly once");
  }
  const results = [];
  for (const planId of planOrder) {
    try {
      results.push({ plan_id: planId, ...(await manager.integrate(byPlanId.get(planId), { targetWorkspace, expectedTargetBranch })) });
    } catch (error) {
      error.integrated_plans = results;
      error.pending_plan_ids = planOrder.slice(results.length);
      throw error;
    }
  }
  return { state: "passed", target_workspace: resolve(targetWorkspace), target_branch: expectedTargetBranch, order: planOrder, integrations: results };
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
    this.blockedExecutionLines = new Set();
    this.poolHandles = new Map();
  }

  async allocate({ planId, mode = "parallel", fixedGroupBase = null, executionLine = null, groupId = "default" }) {
    safePlanPath(planId);
    const sequentialWorkspace = resolve(executionLine || this.repoRoot);
    const base = (await this.runGit(mode === "parallel" ? this.repoRoot : sequentialWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (mode !== "parallel") {
      if (this.blockedExecutionLines.has(sequentialWorkspace)) throw new Error(`Execution line is blocked: ${sequentialWorkspace}`);
      return { planId, mode: "sequential", workspace: sequentialWorkspace, owned: false, baseSha: base, finalHeadSha: null, dirty: null };
    }
    if (this.blockedPools.has(groupId)) throw new Error(`Worktree pool is blocked: ${groupId}`);
    if (!fixedGroupBase) throw new TypeError("fixedGroupBase is required for parallel worktree allocation");
    if (this.groupBases.has(groupId) && this.groupBases.get(groupId) !== fixedGroupBase) throw new Error(`Parallel group ${groupId} has inconsistent fixed base`);
    const workspace = join(this.runtimeRoot, "worktrees", this.runtimeNamespace, safeGroupPath(groupId), safePlanPath(planId));
    const branch = `harness/${this.runtimeNamespace}/${safeGroupPath(groupId)}/${safePlanPath(planId)}-${process.pid}-${++branchInstance}`;
    await ensureDir(join(this.runtimeRoot, "worktrees"));
    let allocatedBase;
    let added = false;
    try {
      await this.runGit(this.repoRoot, ["worktree", "add", "-b", branch, workspace, fixedGroupBase]);
      added = true;
      allocatedBase = (await this.runGit(workspace, ["rev-parse", "HEAD"])).stdout.trim();
      if (allocatedBase !== fixedGroupBase) throw new Error(`Worktree base mismatch: expected ${fixedGroupBase}, got ${allocatedBase}`);
    } catch (error) {
      this.blockedPools.add(groupId);
      if (!this.poolHandles.has(groupId)) this.poolHandles.set(groupId, new Set());
      if (added) {
        const handle = { planId, mode: "parallel", workspace, branch, owned: true, baseSha: allocatedBase || fixedGroupBase, finalHeadSha: null, dirty: null, groupId, fixedGroupBase };
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
    return { planId, mode: "parallel", workspace, branch, owned: true, baseSha: allocatedBase, finalHeadSha: null, dirty: null, groupId, fixedGroupBase };
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
    const dirty = observed.dirty === true;
    return {
      valid: Boolean(block) && actualHead === fixedGroupBase && !dirty,
      workspace,
      fixed_group_base: fixedGroupBase,
      actual_head: actualHead || null,
      dirty,
      dirty_files: observed.dirtyFiles,
      final_head_sha: observed.finalHeadSha,
      observed,
      reason: !block
        ? "worktree_not_registered"
        : actualHead !== fixedGroupBase
          ? "worktree_head_mismatch"
          : dirty
            ? "worktree_dirty"
            : null,
    };
  }

  async cleanup(handle, { evidencePersisted = false } = {}) {
    if (!handle.owned) {
      let observed;
      try { observed = await this.observe(handle); } catch (error) {
        this.blockedExecutionLines.add(handle.workspace);
        return { ...handle, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "workspace_cleanup_failure", error: error.message } };
      }
      if (!evidencePersisted) {
        this.blockedExecutionLines.add(handle.workspace);
        return { ...observed, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "workspace_cleanup_failure", error: "Evidence was not persisted before cleanup" } };
      }
      if (observed.dirty) {
        this.blockedExecutionLines.add(handle.workspace);
        return { ...observed, cleanup: { state: "failed", final_case_state: "inconclusive", reason: "worktree_leak", error: "Dirty execution line cannot be implicitly reset" } };
      }
      this.blockedExecutionLines.delete(handle.workspace);
      return { ...observed, cleanup: { state: "passed", reason: null } };
    }
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

  async integrate(handle, { targetWorkspace, expectedTargetBranch } = {}) {
    if (!handle?.owned || handle.mode !== "parallel" || typeof handle.branch !== "string" || !handle.fixedGroupBase) {
      throw new TypeError("A committed parallel worktree handle is required for integration");
    }
    if (!targetWorkspace || !expectedTargetBranch) throw new TypeError("targetWorkspace and expectedTargetBranch are required");
    const targetRoot = (await this.runGit(targetWorkspace, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const targetBranch = (await this.runGit(targetWorkspace, ["branch", "--show-current"])).stdout.trim();
    const targetStatus = await this.runGit(targetWorkspace, ["status", "--porcelain", "--untracked-files=all"]);
    const targetHead = (await this.runGit(targetWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (resolve(targetRoot) !== resolve(targetWorkspace) || targetBranch !== expectedTargetBranch) {
      const error = new Error(`Integration target mismatch: expected ${expectedTargetBranch} at ${targetWorkspace}`);
      error.reason = "integration_target_mismatch";
      throw error;
    }
    if (targetStatus.stdout.trim()) {
      const error = new Error("Integration target must be clean");
      error.reason = "integration_target_dirty";
      throw error;
    }
    const sourceHead = (await this.runGit(this.repoRoot, ["rev-parse", "--verify", `refs/heads/${handle.branch}`])).stdout.trim();
    const baseIsAncestor = await this.runGit(this.repoRoot, ["merge-base", "--is-ancestor", handle.fixedGroupBase, sourceHead]).then(() => true, () => false);
    const targetContainsBase = await this.runGit(targetWorkspace, ["merge-base", "--is-ancestor", handle.fixedGroupBase, targetHead]).then(() => true, () => false);
    if (!baseIsAncestor || !targetContainsBase) {
      const error = new Error("Integration branches do not share the expected fixed base");
      error.reason = "integration_base_mismatch";
      throw error;
    }
    if (sourceHead === handle.fixedGroupBase) return { state: "passed", branch: handle.branch, source_head: sourceHead, target_branch: targetBranch, target_head: targetHead, merged: false };
    const knowledgeConflicts = await findKnowledgeMergeConflicts(this.repoRoot, {
      base: handle.fixedGroupBase,
      source: sourceHead,
      target: targetHead,
    });
    if (knowledgeConflicts.length) {
      const summary = knowledgeConflicts.map(({ object_kind, id, fields }) => `${object_kind} ${id} (${fields.join(", ")})`).join("; ");
      const error = new Error(`Parallel plan Knowledge merge conflict: ${summary}`);
      error.reason = "knowledge_merge_conflict";
      error.conflicts = knowledgeConflicts;
      throw error;
    }
    try {
      await this.runGit(targetWorkspace, ["merge", "--no-ff", "--no-edit", handle.branch]);
    } catch (error) {
      const conflicts = await this.runGit(targetWorkspace, ["diff", "--name-only", "--diff-filter=U"]).then(({ stdout }) => stdout.trim().split("\n").filter(Boolean), () => []);
      await this.runGit(targetWorkspace, ["merge", "--abort"]).catch(() => {});
      const integrationError = new Error(`Parallel plan integration conflict for ${handle.planId}: ${conflicts.join(", ") || error.message}`);
      integrationError.reason = "integration_conflict";
      integrationError.conflicts = conflicts;
      throw integrationError;
    }
    const mergedHead = (await this.runGit(targetWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
    return { state: "passed", branch: handle.branch, source_head: sourceHead, target_branch: targetBranch, target_head: mergedHead, merged: true };
  }

  async verifyCommitReachable(handle, commitSha) {
    if (!handle?.owned || typeof handle.branch !== "string" || !/^[0-9a-f]{40,64}$/i.test(String(commitSha || ""))) {
      return { valid: false, reason: "invalid_commit_reachability_input", branch: handle?.branch || null, commit_sha: commitSha || null };
    }
    const branchRef = `refs/heads/${handle.branch}`;
    const branchHead = await this.runGit(this.repoRoot, ["rev-parse", "--verify", branchRef]).then(({ stdout }) => stdout.trim(), () => null);
    if (!branchHead) return { valid: false, reason: "implementation_branch_missing", branch: handle.branch, commit_sha: commitSha, branch_head: null };
    const reachable = await this.runGit(this.repoRoot, ["merge-base", "--is-ancestor", commitSha, branchHead]).then(() => true, () => false);
    return { valid: reachable, reason: reachable ? null : "implementation_commit_unreachable", branch: handle.branch, commit_sha: commitSha, branch_head: branchHead };
  }

  isPoolBlocked(groupId) {
    return this.blockedPools.has(groupId);
  }

  isExecutionLineBlocked(executionLine) {
    return this.blockedExecutionLines.has(resolve(executionLine));
  }
}
