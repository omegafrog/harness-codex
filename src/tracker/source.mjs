import { parseYaml } from "../eval/yaml.mjs";
import { TrackerContractError, validatePlanSet } from "./contracts.mjs";
import { renderPlanSetIssue } from "./render.mjs";

export function validatePlanSetSource(source) {
  if (typeof source !== "string" || !source.trim()) throw new TrackerContractError("plan-set structured source must be a non-empty YAML or JSON string");
  try {
    return validatePlanSet(parseYaml(source));
  } catch (error) {
    if (error instanceof TrackerContractError) throw error;
    throw new TrackerContractError(`plan-set structured source is invalid: ${error.message}`, { cause: error });
  }
}

export function preparePlanSetIssue(form) {
  if (!form || typeof form !== "object" || Array.isArray(form)) throw new TrackerContractError("plan-set Issue form must be an object");
  const source = form["structured-source"] ?? form.structured_source;
  const plan = validatePlanSetSource(source);
  return { plan, title: plan.title, body: renderPlanSetIssue(plan) };
}
