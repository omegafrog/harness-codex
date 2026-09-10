import { ResourceGraph } from "../eval/plan-workspace.mjs";
import { buildImplementPrompt, scheduleApprovedPlans } from "./scheduler.mjs";
import { reconcileCheckpointFromSources } from "./checkpoint.mjs";
import { reconcileCompletion } from "./reconciliation.mjs";

function required(value, name) {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

export function resolveImplementationProfile({ config = null, model = null, reasoningEffort = null } = {}) {
  const resolvedModel = config?.agents?.implementation_model || model || config?.agents?.default_model;
  const resolvedReasoning = config?.agents?.implementation_reasoning_effort || reasoningEffort || "high";
  if (!resolvedModel) throw new TypeError("agents.implementation_model must be resolved before dispatch");
  if (resolvedReasoning !== "high") throw new TypeError("Implementation dispatch requires high reasoning effort");
  return { model: resolvedModel, reasoning_effort: resolvedReasoning };
}

/**
 * Dispatches one fresh implement context. It does not run an agent loop or
 * interpret workflow stages; the injected spawn adapter owns process/agent
 * creation.
 */
export async function dispatchImplementPlan({
  plan,
  planSetId,
  repository,
  slotRegistry,
  spawnImplement,
  checkpointStore = null,
  dependencyFacts = {},
  resourceFacts = {},
  smartZone = null,
  workspace = null,
  model = null,
  config = null,
  reasoningEffort = null,
  fixedPoint = null,
  plans = null,
  completedPlanIds = [],
  fixedGroupBase = null,
  readGitState = null,
  readTestState = null,
} = {}) {
  required(plan?.id, "plan.id");
  required(planSetId, "planSetId");
  required(repository, "repository");
  required(slotRegistry, "slotRegistry");
  required(spawnImplement, "spawnImplement");
  if (typeof spawnImplement !== "function") throw new TypeError("spawnImplement must be a function");
  if (!smartZone || typeof smartZone !== "object" || !["dispatch", "before-next-action", "after-action"].includes(smartZone.phase) || !["fits", "handoff-required"].includes(smartZone.state) || typeof smartZone.evidence !== "string" || !smartZone.evidence.trim()) throw new TypeError("A valid Smart Zone assessment is required before dispatch");
  if (typeof readGitState !== "function" || typeof readTestState !== "function") throw new TypeError("readGitState and readTestState are required");
  required(checkpointStore, "checkpointStore");
  required(plans, "plans");
  const profile = resolveImplementationProfile({ config, model, reasoningEffort });
  const schedule = scheduleApprovedPlans(plans, { completedPlanIds, fixedGroupBase });
  if (!schedule.ready_plans.includes(plan.id)) {
    const error = new Error(`Plan ${plan.id} is not ready for dispatch`);
    error.reason = "dependency_not_ready";
    error.schedule = schedule;
    throw error;
  }
  const graph = new ResourceGraph(Object.values(schedule.plan_by_id));
  for (const activePlanId of slotRegistry.activePlanIds()) {
    if (activePlanId === plan.id) continue;
    const activePlan = schedule.plan_by_id[activePlanId];
    if (!activePlan || graph.conflicts(plan.id, activePlanId)) {
      const error = new Error(`Plan ${plan.id} conflicts with active plan ${activePlanId}`);
      error.reason = "resource_conflict";
      error.schedule = schedule;
      throw error;
    }
  }
  const stored = await checkpointStore.read();
  const previous = await reconcileCheckpointFromSources(stored || { plan_id: plan.id }, { readGitState, readTestState });
  let attempt = (previous?.attempt || 0) + 1;
  let checkpoint = {
    ...(previous || {}),
    orchestration_state: "running",
    attempt,
    smart_zone: smartZone,
    handoff_reason: null,
    blocker: null,
  };
  if (smartZone.state === "handoff-required") {
    await checkpointStore.write({ ...checkpoint, orchestration_state: "handoff-required", handoff_reason: "context-threshold", next_action: "start a fresh implement context for the same plan" });
    attempt += 1;
    checkpoint = { ...checkpoint, attempt, handoff_reason: "context-threshold", next_action: "continue the same plan in a fresh implement context" };
  }
  const prompt = buildImplementPrompt({
    repository,
    planSetId,
    planId: plan.id,
    planPath: plan.plan_path || plan.path || null,
    productSpecPath: plan.product_spec_path || null,
    architectureSpecPath: plan.architecture_spec_path || null,
    dependencyFacts,
    resourceFacts,
    smartZone: smartZone.state,
    checkpointPath: checkpointStore.paths.checkpoint_path,
  });
  let slot;
  try {
    slot = slotRegistry.acquire(plan.id, { attempt, workspace });
    await checkpointStore.write(checkpoint);
    const child = await spawnImplement({
      agent_type: "implement",
      plan_id: plan.id,
      plan_set_id: planSetId,
      prompt,
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      fixed_point: fixedPoint,
      schedule,
      fresh_context: true,
      empty_context: true,
      attempt,
    });
    if (child?.context_id) slot.context_id = child.context_id;
    return { state: "dispatched", dispatched: true, plan_id: plan.id, attempt, slot, child, prompt };
  } catch (error) {
    try {
      await checkpointStore.write({ ...checkpoint, blocker: { kind: "dispatch", summary: error.message, unblock_condition: "retry with a fresh implement context" }, next_action: "retry dispatch in a fresh implement context", handoff_reason: "retry" });
    } finally {
      if (slot) slotRegistry.release(slot);
    }
    throw error;
  }
}

/** Run Standards and Spec reviews in independent fresh contexts. */
export async function runIndependentReviewers({
  plan,
  implementation,
  spawnReviewer,
  fixedPoint = null,
  planSetId = null,
  repository = null,
  productSpecPath = null,
  architectureSpecPath = null,
  commitList = null,
  diff = null,
} = {}) {
  required(plan?.id, "plan.id");
  if (typeof spawnReviewer !== "function") throw new TypeError("spawnReviewer must be a function");
  const reviewFixedPoint = fixedPoint || implementation?.fixed_point;
  required(reviewFixedPoint, "fixedPoint");
  required(implementation?.commit_sha, "implementation.commit_sha");
  required(planSetId || plan.plan_set_id, "planSetId");
  const resolvedPlanSetId = planSetId || plan.plan_set_id;
  const reviewInput = {
    repository,
    fixed_point: reviewFixedPoint,
    implementation_commit_sha: implementation.commit_sha,
    commit_list: commitList || implementation.commit_list || [implementation.commit_sha],
    diff_range: { from: reviewFixedPoint, to: implementation.commit_sha },
    diff: diff || implementation.diff || null,
    product_spec_path: productSpecPath || plan.product_spec_path || `docs/specs/${resolvedPlanSetId}/product-spec.md`,
    architecture_spec_path: architectureSpecPath || plan.architecture_spec_path || `docs/specs/${resolvedPlanSetId}/architecture-spec.md`,
  };
  const roles = [
    { role: "standards", agent_type: "standards_reviewer" },
    { role: "spec", agent_type: "spec_reviewer" },
  ];
  const reports = await Promise.all(roles.map(async ({ role, agent_type }) => {
    let report;
    try {
      report = await spawnReviewer({
        agent_type,
        plan_id: plan.id,
        implementation,
        ...reviewInput,
        fresh_context: true,
        empty_context: true,
      });
    } catch (error) {
      return {
        role,
        state: "error",
        independent: false,
        fresh_context: false,
        context_id: null,
        reviewer_agent_type: agent_type,
        implementation_commit_sha: null,
        error: { message: error.message, name: error.name },
        report: null,
      };
    }
    const provenance = report?.provenance || {};
    const implementationCommitSha = report?.implementation_commit_sha || provenance.implementation_commit_sha || null;
    return {
      role,
      state: report?.state || report?.verdict || "unknown",
      independent: report?.independent === true || provenance.independent === true,
      fresh_context: report?.fresh_context === true || provenance.fresh_context === true,
      context_id: report?.context_id || provenance.context_id || null,
      reviewer_agent_type: agent_type,
      implementation_commit_sha: implementationCommitSha,
      report,
    };
  }));
  const contextIds = reports.map((review) => review.context_id).filter(Boolean);
  const independentContexts = contextIds.length === reports.length && new Set(contextIds).size === reports.length;
  return reports.map((review) => ({ ...review, independent: review.independent && independentContexts }));
}

/**
 * Execute the wrapper lifecycle through injected adapters. Waiting, process
 * management, and tracker access remain outside this module's workflow logic.
 */
export async function executeImplementPlan({
  captureFixedPoint,
  waitForImplementation,
  spawnReviewer,
  trackerSnapshot = null,
  pr = {},
  trackerMode = "github",
  dependents = [],
  ...dispatchOptions
} = {}) {
  if (typeof captureFixedPoint !== "function") throw new TypeError("captureFixedPoint is required");
  if (typeof waitForImplementation !== "function") throw new TypeError("waitForImplementation is required");
  if (typeof spawnReviewer !== "function") throw new TypeError("spawnReviewer is required");
  const fixedPoint = await captureFixedPoint();
  if (!fixedPoint) throw new TypeError("captureFixedPoint must return a fixed point");
  const dispatched = await dispatchImplementPlan({ ...dispatchOptions, fixedPoint, spawnImplement: dispatchOptions.spawnImplement });
  if (!dispatched.dispatched) return { fixed_point: fixedPoint, dispatch: dispatched, state: dispatched.state };
  let implementation;
  try {
    implementation = { ...(await waitForImplementation(dispatched.child, dispatched)), fixed_point: fixedPoint };
  } catch (error) {
    if (dispatchOptions.checkpointStore) await dispatchOptions.checkpointStore.write({ blocker: { kind: "execution", summary: error.message, unblock_condition: "retry the same plan with a fresh context" }, next_action: "retry the implementation execution", handoff_reason: "retry" });
    if (dispatchOptions.slotRegistry.has(dispatched.plan_id)) dispatchOptions.slotRegistry.release(dispatched.slot);
    throw error;
  }
  if (dispatchOptions.slotRegistry.has(dispatched.plan_id)) dispatchOptions.slotRegistry.release(dispatched.slot);
  const reviews = await runIndependentReviewers({
    plan: dispatchOptions.plan,
    implementation,
    spawnReviewer,
    fixedPoint,
    planSetId: dispatchOptions.planSetId,
    repository: dispatchOptions.repository,
    productSpecPath: dispatchOptions.plan?.product_spec_path || null,
    architectureSpecPath: dispatchOptions.plan?.architecture_spec_path || null,
  });
  const actual = await reconcileCheckpointFromSources(await dispatchOptions.checkpointStore.read(), { readGitState: dispatchOptions.readGitState, readTestState: dispatchOptions.readTestState });
  const completionEvidence = {
    fixed_point: fixedPoint,
    implementation,
    tests: actual.tests,
    reviews,
    pr,
    required_outcomes: dispatchOptions.requiredOutcomeEvidence || implementation.required_outcome_evidence || null,
  };
  const completion = reconcileCompletion({
    plan: dispatchOptions.plan,
    implementation,
    reviews,
    tests: actual.tests,
    requiredOutcomes: dispatchOptions.requiredOutcomes || dispatchOptions.plan?.required_outcomes || [],
    requiredOutcomeEvidence: dispatchOptions.requiredOutcomeEvidence || implementation.required_outcome_evidence || null,
    evidence: completionEvidence,
    blocker: actual.blocker || dispatchOptions.blocker || null,
    pr,
    trackerSnapshot,
    trackerMode,
    dependents,
  });
  const existingBlocker = actual.blocker || dispatchOptions.blocker || null;
  await dispatchOptions.checkpointStore.write({
    ...actual,
    orchestration_state: actual.orchestration_state || "running",
    last_completed_step: completion.can_complete ? "completion gate passed" : "completion gate unresolved",
    blocker: completion.can_complete ? null : existingBlocker || { kind: "completion-gate", summary: completion.unresolved.join(", "), unblock_condition: "resolve every completion gate finding" },
    next_action: completion.can_complete ? "wait for the selected tracker to remain canonical" : "resolve completion gate findings",
    lifecycle_evidence: {
      fixed_point: fixedPoint,
      implementation: { state: implementation.state || null, commit_sha: implementation.commit_sha || null },
      reviews: reviews.map(({ role, state, context_id, implementation_commit_sha }) => ({ role, state, context_id, implementation_commit_sha })),
      pr: { merged: pr.merged === true },
      tracker_reconciliation: completion.tracker_reconciliation,
      completion: { state: completion.state, unresolved: completion.unresolved },
    },
  });
  return { fixed_point: fixedPoint, dispatch: dispatched, implementation, reviews, completion, state: completion.state };
}
