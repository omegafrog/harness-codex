import { ResourceGraph, schedulePlans } from "../eval/plan-workspace.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACTIVE_STATUSES = new Set(["planned", "in-progress"]);
const TERMINAL_STATUSES = new Set(["completed", "done"]);

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
  const status = plan.status || "planned";
  if (![...ACTIVE_STATUSES, ...TERMINAL_STATUSES, "blocked"].includes(status)) throw new TypeError(`Plan ${plan.id} has unsupported status: ${status}`);
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
  return new ResourceGraph(runnable).canParallelize(runnable.map((plan) => plan.id)) ? null : "shared_resource_conflict";
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

  const schedule = schedulePlans(runnable, { completedPlanIds: [...completed], fixedGroupBase });
  const reason = runnable.length > 1 ? groupReason(runnable, { fixedGroupBase }) : null;
  const groups = schedule.groups.map((group) => ({
    type: group.type,
    plan_ids: group.planIds,
    ...(group.fixed_group_base ? { fixed_group_base: group.fixed_group_base } : {}),
    workspace: group.workspace,
    ...(reason && group.type === "sequential" && group.planIds.length > 1 ? { reason } : group.reason ? { reason: group.reason } : {}),
  }));
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
  constructor() {
    this.active = new Map();
  }

  acquire(planId, { attempt = 1, workspace = null } = {}) {
    if (typeof planId !== "string" || !SAFE_ID.test(planId)) throw new TypeError("planId must be a safe identifier");
    if (this.active.has(planId)) throw new Error(`Plan ${planId} already has an active execution slot`);
    const slot = { slot_id: `slot-${process.pid}-${++slotSequence}`, plan_id: planId, attempt, workspace, state: "running" };
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

  activePlanIds() {
    return [...this.active.keys()];
  }

  has(planId) {
    return this.active.has(planId);
  }
}

export function buildImplementPrompt({ repository, planSetId, planId, dependencyFacts = {}, resourceFacts = {}, smartZone = "unknown", checkpointPath = null } = {}) {
  if (!repository || !planSetId || !planId) throw new TypeError("repository, planSetId, and planId are required");
  return [
    `Repository: ${repository}`,
    `Execute exactly one plan: ${planId}`,
    `Plan set: docs/plans/${planSetId}/plans.md`,
    "Product Spec: docs/specs/product-spec.md",
    "Architecture Spec: docs/specs/architecture-spec.md",
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
