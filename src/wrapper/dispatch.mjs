import { buildImplementPrompt } from "./scheduler.mjs";

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
  smartZone = { phase: "dispatch", state: "fits", evidence: "not assessed by caller" },
  workspace = null,
  model = "agents.implementation_model",
} = {}) {
  required(plan?.id, "plan.id");
  required(slotRegistry, "slotRegistry");
  required(spawnImplement, "spawnImplement");
  if (typeof spawnImplement !== "function") throw new TypeError("spawnImplement must be a function");
  const previous = checkpointStore ? await checkpointStore.read() : null;
  const attempt = (previous?.attempt || 0) + 1;
  const checkpoint = {
    ...(previous || {}),
    orchestration_state: "running",
    attempt,
    smart_zone: smartZone,
    handoff_reason: null,
  };
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
  const reports = await Promise.all(roles.map(async ({ role, agent_type }) => ({
    role,
    report: await spawnReviewer({
      agent_type,
      plan_id: plan.id,
      implementation,
      fresh_context: true,
      empty_context: true,
    }),
  })));
  return reports;
}
