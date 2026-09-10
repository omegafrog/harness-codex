import { ResourceGraph } from "../eval/plan-workspace.mjs";

function resourceLabel(resource) {
  if (typeof resource === "string") return resource.includes(":") ? resource : `filesystem:${resource}`;
  return `${resource.kind}:${resource.name}`;
}

export function detectPlanConflicts(planExecutions) {
  if (!Array.isArray(planExecutions)) throw new TypeError("planExecutions must be an array");
  const plans = planExecutions.map((execution) => ({ id: execution.plan_id || execution.id, resources: execution.resources }));
  const graph = new ResourceGraph(plans);
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex];
      const right = plans[rightIndex];
      if (!graph.conflicts(left.id, right.id)) continue;
      const sharedResources = (left.resources || []).flatMap((leftResource) => {
        const leftLabel = resourceLabel(leftResource);
        return (right.resources || []).filter((rightResource) => {
          const rightLabel = resourceLabel(rightResource);
          return leftLabel === rightLabel || (leftLabel.startsWith("filesystem:") && rightLabel.startsWith("filesystem:") && (leftLabel.startsWith(`${rightLabel}/`) || rightLabel.startsWith(`${leftLabel}/`)));
        }).map((rightResource) => ({ left: leftLabel, right: resourceLabel(rightResource) }));
      });
      conflicts.push({
        conflict_id: `conflict-${left.id}-${right.id}`,
        plan_ids: [left.id, right.id],
        kind: "shared_write_resource",
        shared_resources: sharedResources,
        evidence: "parallel plan outputs overlap in a declared write resource",
      });
    }
  }
  return conflicts;
}

export class ConflictRouter {
  constructor({ checkpointStoreFor, slotRegistry, dispatchPlan } = {}) {
    if (typeof checkpointStoreFor !== "function") throw new TypeError("checkpointStoreFor is required");
    if (!slotRegistry || typeof slotRegistry.pause !== "function") throw new TypeError("slotRegistry is required");
    if (typeof dispatchPlan !== "function") throw new TypeError("dispatchPlan is required");
    this.checkpointStoreFor = checkpointStoreFor;
    this.slotRegistry = slotRegistry;
    this.dispatchPlan = dispatchPlan;
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
    const existing = [...this.paused.values()].find((conflict) => affectedPlanIds.every((planId) => conflict.plan_ids.includes(planId)));
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
    const store = this.checkpointStoreFor(planId);
    const previous = await store.read();
    await store.write({
      ...(previous || {}),
      orchestration_state: "running",
      next_action: "continue implementation after priority routing",
      handoff_reason: "milestone",
    });
    this.slotRegistry.releasePaused(planId);
    const dispatch = await this.dispatchPlan({ plan_id: planId, fresh_context: true, reason: "priority-routed" });
    route.nextIndex += 1;
    return { plan_id: planId, state: "running", next_plan_id: route.resumeOrder[route.nextIndex] || null, dispatch };
  }
}
