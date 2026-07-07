"""Explicit composition root for runtime compatibility extensions."""

from __future__ import annotations

from threading import Lock

_configure_lock = Lock()
_configured = False


def configure_runtime() -> None:
    global _configured
    if _configured:
        return
    with _configure_lock:
        if _configured:
            return
        _install_runtime_extensions()
        _configured = True


def _install_runtime_extensions() -> None:
    from harness_codex.runtime.serena_patch import apply_serena_mcp_patch
    from harness_codex.runtime.observability_patch import apply_observability_patch
    from harness_codex.runtime.delivery_runner_patch import apply_delivery_runner_patch
    from harness_codex.runtime.plan_transition_policy_patch import apply_plan_transition_policy_patch
    from harness_codex.runtime.plan_completion_boundary_patch import apply_plan_completion_boundary_patch
    from harness_codex.runtime.procedure_stage_compatibility_patch import apply_procedure_stage_compatibility_patch
    from harness_codex.runtime.dashboard_runtime_state import apply_dashboard_runtime_state_patch
    from harness_codex.runtime.changeset_deletion_runtime_patch import apply_changeset_deletion_runtime_cleanup_patch
    from harness_codex.runtime.verification_repair_dashboard_patch import install_verification_repair_dashboard_patch
    from harness_codex.runtime.dashboard_ddd_integration_patch import apply_dashboard_ddd_integration_patch
    from harness_codex.runtime.grill_me_question_batch_patch import apply_grill_me_question_batch_patch
    from harness_codex.runtime.agent_output_contract_patch import apply_agent_output_contract_patch
    from harness_codex.runtime.agent_trace_retention_patch import apply_agent_trace_retention_patch
    from harness_codex.runtime.interactive_agent_transaction_patch import apply_interactive_agent_transaction_patch
    from harness_codex.runtime.interactive_agent_scope_validation_patch import apply_interactive_agent_scope_validation_patch
    from harness_codex.runtime.ddd_candidate_efficiency_patch import apply_ddd_candidate_efficiency_patch
    from harness_codex.runtime.ddd_candidate_input_integrity_patch import apply_ddd_candidate_input_integrity_patch
    from harness_codex.runtime.ddd_integration_candidate_provenance_patch import apply_ddd_integration_candidate_provenance_patch
    from harness_codex.runtime.agent_write_scope_policy_patch import apply_agent_write_scope_policy_patch
    from harness_codex.runtime.scope_violation_recovery_patch import apply_scope_violation_recovery_patch
    from harness_codex.runtime.procedure_stage_runtime_state_patch import apply_procedure_stage_runtime_state_patch
    from harness_codex.runtime.temporary_changeset_canonical_state_patch import apply_temporary_changeset_canonical_state_patch
    from harness_codex.runtime.dashboard_gate_state_patch import apply_dashboard_gate_state_patch
    from harness_codex.runtime.dashboard_final_design_result_patch import apply_dashboard_final_design_result_patch
    from harness_codex.runtime.changeset_scope_isolation_patch import apply_changeset_scope_isolation_patch
    from harness_codex.runtime.canonical_stage_gate_authority_patch import apply_canonical_stage_gate_authority_patch
    from harness_codex.runtime.security_review_prompt_patch import apply_security_review_prompt_patch

    apply_serena_mcp_patch()
    install_verification_repair_dashboard_patch()
    apply_observability_patch()
    apply_delivery_runner_patch()
    apply_plan_transition_policy_patch()
    apply_plan_completion_boundary_patch()
    apply_procedure_stage_compatibility_patch()
    apply_dashboard_runtime_state_patch()
    apply_changeset_deletion_runtime_cleanup_patch()
    apply_dashboard_ddd_integration_patch()
    apply_grill_me_question_batch_patch()
    apply_agent_output_contract_patch()
    apply_agent_trace_retention_patch()
    apply_interactive_agent_transaction_patch()
    apply_interactive_agent_scope_validation_patch()
    apply_ddd_candidate_efficiency_patch()
    apply_ddd_candidate_input_integrity_patch()
    apply_ddd_integration_candidate_provenance_patch()
    apply_agent_write_scope_policy_patch()
    apply_scope_violation_recovery_patch()
    apply_procedure_stage_runtime_state_patch()
    apply_temporary_changeset_canonical_state_patch()
    apply_dashboard_gate_state_patch()
    apply_dashboard_final_design_result_patch()
    apply_changeset_scope_isolation_patch()
    apply_canonical_stage_gate_authority_patch()
    apply_security_review_prompt_patch()
