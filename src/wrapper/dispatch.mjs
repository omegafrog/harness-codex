import { buildImplementPrompt } from "./scheduler.mjs";
import { reconcileCheckpointFromSources } from "./checkpoint.mjs";
import { reconcileCompletion } from "./reconciliation.mjs";

function required(value, name) {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

export function resolveImplementationProfile({ config = null, model = null, reasoningEffort = null } = {}) {
  const resolvedModel = model || config?.agents?.implementation_model;
  const resolvedReasoning = reasoningEffort || config?.agents?.implementation_reasoning_effort || "high";
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
  readGitState = null,
  readTestState = null,
} = {}) {
  required(plan?.id, "plan.id");
  required(planSetId, "planSetId");
  required(repository, "repository");
  required(slotRegistry, "slotRegistry");
  required(spawnImplement, "spawnImplement");
  if (typeof spawnImplement !== "function") throw new TypeError("spawnImplement must be a function");
  if (checkpointStore && (typeof readGitState !== "function" || typeof readTestState !== "function")) throw new TypeError("readGitState and readTestState are required when checkpointStore is used");
  if (!smartZone || typeof smartZone !== "object" || !["dispatch", "before-next-action", "after-action"].includes(smartZone.phase) || !["fits", "handoff-required"].includes(smartZone.state) || typeof smartZone.evidence !== "string" || !smartZone.evidence.trim()) throw new TypeError("A valid Smart Zone assessment is required before dispatch");
  const profile = resolveImplementationProfile({ config, model, reasoningEffort });
  const stored = checkpointStore ? await checkpointStore.read() : null;
  const previous = checkpointStore
    ? await reconcileCheckpointFromSources(stored || { plan_id: plan.id }, { readGitState, readTestState })
    : null;
  const attempt = (previous?.attempt || 0) + 1;
  const checkpoint = {
    ...(previous || {}),
    orchestration_state: "running",
    attempt,
    smart_zone: smartZone,
    handoff_reason: null,
    blocker: null,
  };
  if (smartZone.state === "handoff-required") {
    if (checkpointStore) await checkpointStore.write({ ...checkpoint, orchestration_state: "handoff-required", handoff_reason: "context-threshold", next_action: "start a fresh implement context for the same plan" });
    return { state: "handoff-required", dispatched: false, plan_id: plan.id, attempt };
  }
  const prompt = buildImplementPrompt({
    repository,
    planSetId,
    planId: plan.id,
    dependencyFacts,
    resourceFacts,
    smartZone: smartZone.state,
    checkpointPath: checkpointStore?.paths.checkpoint_path,
  });
  let slot;
  try {
    slot = slotRegistry.acquire(plan.id, { attempt, workspace });
    if (checkpointStore) await checkpointStore.write(checkpoint);
    const child = await spawnImplement({
      agent_type: "implement",
      plan_id: plan.id,
      plan_set_id: planSetId,
      prompt,
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      fixed_point: fixedPoint,
      fresh_context: true,
      empty_context: true,
      attempt,
    });
    return { state: "dispatched", dispatched: true, plan_id: plan.id, attempt, slot, child, prompt };
  } catch (error) {
    try {
      if (checkpointStore) await checkpointStore.write({ ...checkpoint, blocker: { kind: "dispatch", summary: error.message, unblock_condition: "retry with a fresh implement context" }, next_action: "retry dispatch in a fresh implement context", handoff_reason: "retry" });
    } finally {
      if (slot) slotRegistry.release(slot);
    }
    throw error;
  }
}

/** Run Standards and Spec reviews in independent fresh contexts. */
export async function runIndependentReviewers({ plan, implementation, spawnReviewer } = {}) {
  required(plan?.id, "plan.id");
  if (typeof spawnReviewer !== "function") throw new TypeError("spawnReviewer must be a function");
  const roles = [
    { role: "standards", agent_type: "standards_reviewer" },
    { role: "spec", agent_type: "spec_reviewer" },
  ];
  const reports = await Promise.all(roles.map(async ({ role, agent_type }) => {
    const report = await spawnReviewer({
      agent_type,
      plan_id: plan.id,
      implementation,
      fresh_context: true,
      empty_context: true,
    });
    const provenance = report?.provenance || {};
    const implementationCommitSha = report?.implementation_commit_sha || provenance.implementation_commit_sha || report?.fixed_point || null;
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
  const reviews = await runIndependentReviewers({ plan: dispatchOptions.plan, implementation, spawnReviewer });
  const completion = reconcileCompletion({ plan: dispatchOptions.plan, implementation, reviews, pr, trackerSnapshot, trackerMode, dependents });
  return { fixed_point: fixedPoint, dispatch: dispatched, implementation, reviews, completion, state: completion.state };
}
