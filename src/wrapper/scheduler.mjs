import { ResourceGraph } from "../eval/plan-workspace.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUS_ALIASES = new Map([
  ["planned", "planned"],
  ["Planned", "planned"],
  ["in-progress", "in-progress"],
  ["In Progress", "in-progress"],
  ["completed", "completed"],
  ["Done", "completed"],
  ["done", "completed"],
  ["blocked", "blocked"],
  ["Blocked", "blocked"],
]);
const ACTIVE_STATUSES = new Set(["planned", "in-progress"]);
const TERMINAL_STATUSES = new Set(["completed"]);

function normalizePlan(plan, index) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new TypeError(`Plan ${index} must be an object`);
  if (typeof plan.id !== "string" || !SAFE_ID.test(plan.id)) throw new TypeError(`Plan ${index} has an unsafe id`);
  const dependencies = plan.dependencies === undefined ? [] : plan.dependencies;
  if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== "string" || !SAFE_ID.test(id))) {
    throw new TypeError(`Plan ${plan.id} dependencies must be safe identifiers`);
  }
  if (dependencies.includes(plan.id)) throw new TypeError(`Plan ${plan.id} cannot depend on itself`);
  const resources = plan.resources === undefined ? null : plan.resources;
  if (resources !== null && (!Array.isArray(resources) || resources.length === 0)) throw new TypeError(`Plan ${plan.id} resources must be a non-empty list when provided`);
  const rawStatus = plan.status || "planned";
  const status = STATUS_ALIASES.get(rawStatus);
  if (!status) throw new TypeError(`Plan ${plan.id} has unsupported status: ${rawStatus}`);
  return { ...plan, status, dependencies, resources };
}

function normalizePlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) throw new TypeError("plans must be a non-empty list");
  const normalized = plans.map(normalizePlan);
  const ids = new Set();
  for (const plan of normalized) {
    if (ids.has(plan.id)) throw new TypeError(`Duplicate plan id: ${plan.id}`);
    ids.add(plan.id);
  }
  return normalized;
}

function groupReason(runnable, { fixedGroupBase }) {
  if (!runnable.every((plan) => Array.isArray(plan.resources) && plan.resources.length > 0)) return "resource_independence_unknown";
  if (!fixedGroupBase) return "missing_fixed_group_base";
  return null;
}

/**
 * Compute the wrapper's dispatch decision without spawning an agent.
 * A split plan is only a scheduling input; it never implies parallel execution.
 */
export function scheduleApprovedPlans(plans, { completedPlanIds = [], fixedGroupBase = null } = {}) {
  const normalized = normalizePlans(plans);
  const completed = new Set(completedPlanIds);
  for (const plan of normalized) if (TERMINAL_STATUSES.has(plan.status)) completed.add(plan.id);
  const runnable = normalized.filter((plan) => ACTIVE_STATUSES.has(plan.status) && plan.dependencies.every((dependency) => completed.has(dependency)));
  const waiting = normalized
    .filter((plan) => !runnable.includes(plan) && !TERMINAL_STATUSES.has(plan.status))
    .map((plan) => {
      const reasons = [];
      for (const dependency of plan.dependencies) if (!completed.has(dependency)) reasons.push(`dependency:${dependency}`);
      if (plan.status === "blocked") reasons.push("status:blocked");
      if (!reasons.length) reasons.push(`status:${plan.status}`);
      return { plan_id: plan.id, reasons };
    });

  const reason = runnable.length > 1 ? groupReason(runnable, { fixedGroupBase }) : null;
  let groups;
  if (reason) {
    groups = [{ type: "sequential", plan_ids: runnable.map((plan) => plan.id), workspace: "execution_line", reason }];
  } else {
    const resourceGraph = new ResourceGraph(runnable);
    const batches = [];
    for (const plan of runnable) {
      const batch = batches.find((candidate) => candidate.every((other) => !resourceGraph.conflicts(plan.id, other.id)));
      if (batch) batch.push(plan);
      else batches.push([plan]);
    }
    groups = batches.map((batch) => {
      const planIds = batch.map((plan) => plan.id);
      const conflicted = runnable.length > 1 && runnable.some((plan) => plan.id !== planIds[0] && resourceGraph.conflicts(plan.id, planIds[0]));
      return batch.length > 1
        ? { type: "parallel", plan_ids: planIds, fixed_group_base: fixedGroupBase, workspace: "isolated_worktree" }
        : { type: "sequential", plan_ids: planIds, workspace: "execution_line", ...(conflicted ? { reason: "shared_resource_conflict" } : {}) };
    });
  }
  return {
    ready_plans: runnable.map((plan) => plan.id),
    waiting_plans: waiting,
    parallel_groups: groups,
    single_slot_plan_ids: groups.flatMap((group) => group.plan_ids),
    blocked_graph: runnable.length === 0 && waiting.length > 0,
    plan_by_id: Object.fromEntries(normalized.map((plan) => [plan.id, plan])),
  };
}

let slotSequence = 0;

export class ExecutionSlotRegistry {
  constructor({ stopSlot = null } = {}) {
    this.active = new Map();
    this.stopSlot = stopSlot;
  }

  acquire(planId, { attempt = 1, workspace = null, onPause = null, contextId = null } = {}) {
    if (typeof planId !== "string" || !SAFE_ID.test(planId)) throw new TypeError("planId must be a safe identifier");
    if (this.active.has(planId)) throw new Error(`Plan ${planId} already has an active execution slot`);
    const slot = { slot_id: `slot-${process.pid}-${++slotSequence}`, plan_id: planId, attempt, workspace, state: "running", onPause, context_id: contextId };
    this.active.set(planId, slot);
    return slot;
  }

  release(slotOrId) {
    const slotId = typeof slotOrId === "string" ? slotOrId : slotOrId?.slot_id;
    const entry = [...this.active.entries()].find(([, slot]) => slot.slot_id === slotId);
    if (!entry) throw new Error(`Unknown or already released execution slot: ${slotId}`);
    entry[1].state = "released";
    this.active.delete(entry[0]);
    return entry[1];
  }

  async pause(planId, reason = {}) {
    const slot = this.active.get(planId);
    if (!slot) return { plan_id: planId, active: false, state: "not-running" };
    if (slot.state !== "running") return { plan_id: planId, active: true, state: slot.state };
    const stopper = slot.onPause || this.stopSlot;
    if (typeof stopper !== "function") throw new Error(`Active execution slot ${slot.slot_id} has no stop handler`);
    await stopper(slot, reason);
    slot.state = "conflict-paused";
    return { plan_id: planId, active: true, state: slot.state, slot_id: slot.slot_id };
  }

  releasePaused(planId) {
    const slot = this.active.get(planId);
    if (!slot) return null;
    if (slot.state !== "conflict-paused") throw new Error(`Execution slot ${slot.slot_id} is not conflict-paused`);
    this.active.delete(planId);
    slot.state = "released";
    return slot;
  }

  activePlanIds() {
    return [...this.active.keys()];
  }

  runningPlanIds() {
    return [...this.active.entries()]
      .filter(([, slot]) => slot.state === "running")
      .map(([planId]) => planId);
  }

  get(planId) {
    return this.active.get(planId) || null;
  }

  has(planId) {
    return this.active.has(planId);
  }
}

export function buildImplementPrompt({
  repository,
  planSetId,
  planId,
  planPath = null,
  productSpecPath = null,
  architectureSpecPath = null,
  dependencyFacts = {},
  resourceFacts = {},
  smartZone = "unknown",
  checkpointPath = null,
} = {}) {
  if (!repository || !planSetId || !planId) throw new TypeError("repository, planSetId, and planId are required");
  const planSetPath = `docs/plans/${planSetId}/plans.md`;
  return [
    `Repository: ${repository}`,
    `Execute exactly one plan: ${planId}`,
    `Plan: ${planPath || planSetPath} (split plan: ${planId})`,
    `Plan set: ${planSetPath}`,
    `Product Spec: ${productSpecPath || `docs/specs/${planSetId}/product-spec.md`}`,
    `Architecture Spec: ${architectureSpecPath || `docs/specs/${planSetId}/architecture-spec.md`}`,
    "Implementation contract: .codex/skills/implement/SKILL.md",
    `Checkpoint: ${checkpointPath || `docs/plans/.runtime/${planId}/checkpoint.md`}`,
    `Dependency facts: ${JSON.stringify(dependencyFacts)}`,
    `Resource facts: ${JSON.stringify(resourceFacts)}`,
    `Context Smart Zone assessment: ${smartZone}`,
    "Stay strictly within this plan's scope and report implementation evidence.",
    "Do not implement checkpoint, conflict, or reconciliation orchestration.",
  ].join("\n");
}

export { normalizePlan };
