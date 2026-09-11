import { parseYaml } from "../eval/yaml.mjs";
import { TrackerContractError, validatePlanSet } from "./contracts.mjs";

export function validatePlanSetSource(source) {
  if (typeof source !== "string" || !source.trim()) throw new TrackerContractError("plan-set structured source must be a non-empty YAML or JSON string");
  try {
    return validatePlanSet(parseYaml(source));
  } catch (error) {
    if (error instanceof TrackerContractError) throw error;
    throw new TrackerContractError(`plan-set structured source is invalid: ${error.message}`, { cause: error });
  }
}
