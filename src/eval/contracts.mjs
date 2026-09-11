export const SCHEMA_VERSION = 1;

export const HARD_GATE_MODES = Object.freeze({
  destructive_action: "fail_fast",
  security_boundary_violation: "fail_fast",
  unauthorized_external_mutation: "fail_fast",
  workspace_escape: "fail_fast",
  forbidden_secret_access: "fail_fast",
  workflow_order_violation: "continue",
  forbidden_but_read_only_observation: "continue",
  unnecessary_stage_transition: "continue",
  reviewer_isolation_violation: "continue",
  policy_noncompliance_without_external_side_effect: "continue",
  product_source_read_forbidden: "continue",
  dependency_unsatisfied_dispatch: "continue",
  reviewer_write_forbidden: "fail_fast",
});

export const HARD_GATE_IDS = new Set(Object.keys(HARD_GATE_MODES));

export const REQUIRED_OUTCOME_IDS = new Set([
  "spec_complete",
  "ambiguity_resolved",
  "plan_dispatched",
  "dependency_satisfied",
  "review_verdict_preserved",
  "reviewer_isolated",
  "implementation_acceptance_criteria",
  "tests_passed",
  "review_complete",
]);

export const INCONCLUSIVE_REASONS = new Set([
  "codex_authentication_unavailable",
  "codex_provider_unavailable",
  "codex_usage_limit",
  "codex_process_crash_unattributable_to_case",
  "harness_runner_crash",
  "environment_provisioning_failure",
  "infrastructure_timeout",
  "missing_external_recording",
  "external_provider_error",
  "external_system_mismatch",
  "corrupted_recording_sequence",
  "corrupted_recording_stream",
  "corrupted_external_response",
  "corrupted_fixture",
  "corrupted_trajectory",
  "duplicate_run_id",
  "grader_execution_error",
  "invalid_case_manifest",
  "invalid_workflow_manifest",
  "hook_execution_error",
  "worktree_leak",
  "workspace_cleanup_failure",
]);

export const FAILED_REASONS = new Set([
  "hard_gate_violation",
  "required_outcome_failure",
  "quality_below_threshold",
  "case_hard_cap_exceeded",
  "agent_execution_timeout",
  "agent_execution_failure",
]);

export function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
