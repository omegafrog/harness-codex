import { buildImplementPrompt } from "./scheduler.mjs";
import { reconcileCheckpointFromSources } from "./checkpoint.mjs";

function required(value, name) {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
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
  model = "agents.implementation_model",
  readGitState = null,
  readTestState = null,
} = {}) {
  required(plan?.id, "plan.id");
  required(slotRegistry, "slotRegistry");
  required(spawnImplement, "spawnImplement");
  if (typeof spawnImplement !== "function") throw new TypeError("spawnImplement must be a function");
  if (checkpointStore && (typeof readGitState !== "function" || typeof readTestState !== "function")) throw new TypeError("readGitState and readTestState are required when checkpointStore is used");
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
  };
  if (!smartZone || typeof smartZone !== "object" || !["dispatch", "before-next-action", "after-action"].includes(smartZone.phase) || !["fits", "handoff-required"].includes(smartZone.state) || typeof smartZone.evidence !== "string" || !smartZone.evidence.trim()) throw new TypeError("A valid Smart Zone assessment is required before dispatch");
  if (smartZone.state === "handoff-required") {
    if (checkpointStore) await checkpointStore.write({ ...checkpoint, orchestration_state: "handoff-required", handoff_reason: "context-threshold", next_action: "start a fresh implement context for the same plan" });
    return { state: "handoff-required", dispatched: false, plan_id: plan.id, attempt };
  }
  if (checkpointStore) await checkpointStore.write(checkpoint);
  const slot = slotRegistry.acquire(plan.id, { attempt, workspace });
  const prompt = buildImplementPrompt({
    repository,
    planSetId,
    planId: plan.id,
    dependencyFacts,
    resourceFacts,
    smartZone: smartZone.state,
    checkpointPath: checkpointStore?.paths.checkpoint_path,
  });
  try {
    const child = await spawnImplement({
      agent_type: "implement",
      plan_id: plan.id,
      plan_set_id: planSetId,
      prompt,
      model,
      reasoning_effort: "high",
      fresh_context: true,
      empty_context: true,
      attempt,
    });
    return { state: "dispatched", dispatched: true, plan_id: plan.id, attempt, slot, child, prompt };
  } catch (error) {
    slotRegistry.release(slot);
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
    return {
      role,
      state: report?.state || report?.verdict || "unknown",
      independent: true,
      fresh_context: true,
      reviewer_agent_type: agent_type,
      implementation_commit_sha: implementation?.commit_sha || null,
      report,
    };
  }));
  return reports;
}
