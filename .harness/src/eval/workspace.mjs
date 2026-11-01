// Backward-compatible exports. Case lifecycle and plan scheduling have separate ownership modules.
export {
  provisionCaseWorkspace,
  assertWorkspaceTarget,
  cleanupCaseWorkspace,
} from "./case-workspace.mjs";

export {
  ResourceGraph,
  schedulePlans,
  runScheduledPlanGroup,
  WorktreeManager,
} from "./plan-workspace.mjs";
