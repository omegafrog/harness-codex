const POLICY_KEYS = new Set([
  "reviewer",
  "researcher",
  "new_split_plan",
  "same_split_plan",
  "smart_zone_exceeded",
  "fork",
  "compact",
]);

const POLICY_VALUES = Object.freeze({
  reviewer: new Set(["isolated"]),
  researcher: new Set(["isolated"]),
  new_split_plan: new Set(["fresh"]),
  same_split_plan: new Set(["continue"]),
  smart_zone_exceeded: new Set(["checkpoint-and-fresh"]),
  fork: new Set(["experimental"]),
  compact: new Set(["experimental"]),
});

export const DEFAULT_CONTEXT_POLICY = Object.freeze({
  reviewer: "isolated",
  researcher: "isolated",
  new_split_plan: "fresh",
  same_split_plan: "continue",
  smart_zone_exceeded: "checkpoint-and-fresh",
  fork: "experimental",
  compact: "experimental",
});

function policySource({ config = null, overrides = null, profile = null } = {}) {
  if (overrides !== null && overrides !== undefined) return overrides;
  return config?.context_policy || config?.wrapper?.context_policy || profile?.context_policy || {};
}

export function resolveContextPolicy(options = {}) {
  const source = policySource(options);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("context policy must be an object");
  const unknown = Object.keys(source).find((key) => !POLICY_KEYS.has(key));
  if (unknown) throw new TypeError(`unknown context policy key: ${unknown}`);
  const policy = { ...DEFAULT_CONTEXT_POLICY, ...source };
  for (const key of POLICY_KEYS) if (!POLICY_VALUES[key].has(policy[key])) throw new TypeError(`invalid context policy value for ${key}: ${policy[key]}`);
  return Object.freeze(policy);
}

export function selectContextPolicy({ config = null, policy = null, profile = null, actor = null, planTransition = null, smartZoneState = null, event = null } = {}) {
  const resolved = resolveContextPolicy({ config, overrides: policy, profile });
  if (smartZoneState === "handoff-required") return { mode: resolved.smart_zone_exceeded, fresh_context: true, empty_context: true, checkpoint: true, reason: "smart-zone-exceeded" };
  if (actor === "reviewer") return { mode: resolved.reviewer, fresh_context: true, empty_context: true, checkpoint: false, reason: "reviewer-isolated" };
  if (actor === "researcher") return { mode: resolved.researcher, fresh_context: true, empty_context: true, checkpoint: false, reason: "researcher-isolated" };
  if (event === "fork") return { mode: resolved.fork, fresh_context: false, empty_context: false, checkpoint: false, reason: "fork-experimental" };
  if (event === "compact") return { mode: resolved.compact, fresh_context: false, empty_context: false, checkpoint: false, reason: "compact-experimental" };
  if (planTransition === "new_split_plan") return { mode: resolved.new_split_plan, fresh_context: true, empty_context: true, checkpoint: false, reason: "new-split-plan" };
  if (planTransition === "same_split_plan") return { mode: resolved.same_split_plan, fresh_context: false, empty_context: false, checkpoint: false, reason: "same-split-plan" };
  throw new TypeError("context policy decision needs actor, planTransition, smartZoneState, or event");
}

export { POLICY_KEYS };
