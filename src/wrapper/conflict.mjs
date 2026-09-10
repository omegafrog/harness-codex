import { ResourceGraph } from "../eval/plan-workspace.mjs";

function resourceLabel(resource) {
  if (typeof resource === "string") return resource.includes(":") ? resource : `filesystem:${resource}`;
  return `${resource.kind}:${resource.name}`;
}

export function detectPlanConflicts(planExecutions) {
  if (!Array.isArray(planExecutions)) throw new TypeError("planExecutions must be an array");
  const plans = planExecutions.map((execution) => ({ id: execution.plan_id || execution.id, resources: execution.resources }));
  const graph = new ResourceGraph(plans);
  const parent = plans.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const pairs = [];
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      if (!graph.conflicts(left.id, right.id)) continue;
      union(leftIndex, rightIndex);
      pairs.push({ leftIndex, rightIndex });
    }
  }
  const components = new Map();
  for (const pair of pairs) {
    const root = find(pair.leftIndex);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(pair);
  }
  return [...components.values()].map((component) => {
    const indexes = [...new Set(component.flatMap(({ leftIndex, rightIndex }) => [leftIndex, rightIndex]))].sort((left, right) => left - right);
    const componentPlans = indexes.map((index) => plans[index]);
    const knownResources = componentPlans.every((plan) => Array.isArray(plan.resources) && plan.resources.length > 0);
    const sharedResources = knownResources ? component.flatMap(({ leftIndex, rightIndex }) => {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      return (left.resources || []).flatMap((leftResource) => {
        const leftLabel = resourceLabel(leftResource);
        return (right.resources || []).filter((rightResource) => {
          const rightLabel = resourceLabel(rightResource);
          return leftLabel === rightLabel || (leftLabel.startsWith("filesystem:") && rightLabel.startsWith("filesystem:") && (leftLabel.startsWith(`${rightLabel}/`) || rightLabel.startsWith(`${leftLabel}/`)));
        }).map((rightResource) => ({ left: leftLabel, right: resourceLabel(rightResource) }));
      });
    }) : [];
    const uniqueSharedResources = [...new Map(sharedResources.map((resource) => [`${resource.left}|${resource.right}`, resource])).values()];
    const planIds = componentPlans.map((plan) => plan.id);
    return {
      conflict_id: `conflict-${planIds.join("-")}`,
      plan_ids: planIds,
      kind: knownResources ? "shared_write_resource" : "resource_independence_unknown",
      shared_resources: uniqueSharedResources,
      evidence: knownResources ? "parallel plan outputs overlap in a declared write resource" : "parallel plan resource independence is unknown; serialize conservatively",
    };
  });
}

export class ConflictRouter {
  constructor({ checkpointStoreFor, slotRegistry, dispatchPlan, recalculateReady } = {}) {
    if (typeof checkpointStoreFor !== "function") throw new TypeError("checkpointStoreFor is required");
    if (!slotRegistry || typeof slotRegistry.pause !== "function") throw new TypeError("slotRegistry is required");
    if (typeof dispatchPlan !== "function") throw new TypeError("dispatchPlan is required");
    if (typeof recalculateReady !== "function") throw new TypeError("recalculateReady is required");
    this.checkpointStoreFor = checkpointStoreFor;
    this.slotRegistry = slotRegistry;
    this.dispatchPlan = dispatchPlan;
    this.recalculateReady = recalculateReady;
    this.paused = new Map();
    this.routes = new Map();
  }

  async pause(conflict) {
    if (!conflict?.conflict_id || !Array.isArray(conflict.plan_ids) || conflict.plan_ids.length < 2) throw new TypeError("A conflict with at least two plan ids is required");
    this.paused.set(conflict.conflict_id, conflict);
    await Promise.all(conflict.plan_ids.map((planId) => this.slotRegistry.pause(planId, { conflict_id: conflict.conflict_id, reason: conflict.evidence })));
    await Promise.all(conflict.plan_ids.map(async (planId) => {
      const store = this.checkpointStoreFor(planId);
      const previous = await store.read();
      await store.write({
        ...(previous || {}),
        orchestration_state: "conflict-paused",
        blocker: {
          kind: "conflict",
          summary: conflict.evidence,
          unblock_condition: "main session makes an explicit priority decision",
          conflict_id: conflict.conflict_id,
          affected_plan_ids: conflict.plan_ids,
          shared_resources: conflict.shared_resources,
        },
        next_action: "wait for explicit priority routing",
        handoff_reason: "milestone",
      });
    }));
    return { ...conflict, state: "conflict-paused" };
  }

  async routePriority({ affectedPlanIds, selectedPlanId } = {}) {
    if (!Array.isArray(affectedPlanIds) || affectedPlanIds.length < 2 || !affectedPlanIds.includes(selectedPlanId)) throw new TypeError("Select exactly one affected plan");
    const uniquePlanIds = new Set(affectedPlanIds);
    const existing = [...this.paused.values()].find((conflict) => affectedPlanIds.length === conflict.plan_ids.length && uniquePlanIds.size === conflict.plan_ids.length && conflict.plan_ids.every((planId) => uniquePlanIds.has(planId)));
    if (!existing) throw new Error("No matching conflict is paused");
    const remaining = affectedPlanIds.filter((planId) => planId !== selectedPlanId);
    const resumeOrder = [selectedPlanId, ...remaining];
    this.routes.set(existing.conflict_id, { selectedPlanId, resumeOrder, nextIndex: 0 });
    await Promise.all(affectedPlanIds.map(async (planId) => {
      const store = this.checkpointStoreFor(planId);
      const previous = await store.read();
      await store.write({
        ...(previous || {}),
        orchestration_state: "priority-routed",
        blocker: previous?.blocker ? { ...previous.blocker, unblock_condition: `resume order starts with ${selectedPlanId}` } : null,
        next_action: planId === selectedPlanId ? "resume this plan first" : `wait until ${selectedPlanId} completes and the graph is re-evaluated`,
        handoff_reason: "milestone",
      });
    }));
    return { conflict_id: existing.conflict_id, selected_plan_id: selectedPlanId, resume_order: resumeOrder, auto_merge: false };
  }

  async resume(planId, { completedPlanIds = [] } = {}) {
    const route = [...this.routes.values()].find((candidate) => candidate.resumeOrder[candidate.nextIndex] === planId);
    if (!route) {
      if ([...this.paused.values()].some((conflict) => conflict.plan_ids.includes(planId))) throw new Error("Cannot resume before the main session makes an explicit priority decision");
      throw new Error(`Plan ${planId} is not routed for resume`);
    }
    const previousPlanId = route.resumeOrder[route.nextIndex - 1];
    if (previousPlanId && !completedPlanIds.includes(previousPlanId)) throw new Error(`Cannot resume ${planId} before ${previousPlanId} completes and the graph is re-evaluated`);
    const readyPlanIds = await this.recalculateReady({ completedPlanIds: [...completedPlanIds] });
    if (!Array.isArray(readyPlanIds) || !readyPlanIds.includes(planId)) throw new Error(`Cannot resume ${planId} because dependency/resource graph is not ready`);
    const store = this.checkpointStoreFor(planId);
    const previous = await store.read();
    this.slotRegistry.releasePaused(planId);
    let dispatch;
    try {
      dispatch = await this.dispatchPlan({ plan_id: planId, fresh_context: true, reason: "priority-routed" });
      if (!this.slotRegistry.has(planId)) throw new Error(`Fresh dispatch for ${planId} did not acquire an execution slot`);
    } catch (error) {
      await store.write({
        ...(previous || {}),
        orchestration_state: "priority-routed",
        blocker: { kind: "dispatch", summary: error.message, unblock_condition: "retry fresh-context dispatch for the selected plan" },
        next_action: "retry fresh-context dispatch for the selected plan",
        handoff_reason: "retry",
      });
      throw error;
    }
    await store.write({
      ...(previous || {}),
      orchestration_state: "running",
      blocker: null,
      next_action: "continue implementation after priority routing",
      handoff_reason: "milestone",
    });
    route.nextIndex += 1;
    return { plan_id: planId, state: "running", next_plan_id: route.resumeOrder[route.nextIndex] || null, dispatch };
  }
}
