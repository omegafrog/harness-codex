"""Explicit composition root for optional runtime extensions.

The core package and runtime export module are import-safe. Executable entry
points call :func:`configure_runtime` once before dispatching commands.
"""

from __future__ import annotations

from threading import Lock

_configure_lock = Lock()
_configured = False


def configure_runtime() -> None:
    """Install remaining compatibility extensions once for an executable session."""

    global _configured
    if _configured:
        return
    with _configure_lock:
        if _configured:
            return
        _install_runtime_extensions()
        _configured = True


def _install_runtime_extensions() -> None:
    # Preserve the former installation order while hooks are being absorbed by
    # their owning modules. The public entrypoint no longer replaces CLI methods.
    from harness_codex.runtime.serena_patch import apply_serena_mcp_patch
    from harness_codex.runtime.observability_patch import apply_observability_patch
    from harness_codex.runtime.delivery_runner_patch import apply_delivery_runner_patch
    from harness_codex.runtime.plan_transition_policy_patch import apply_plan_transition_policy_patch
    from harness_codex.runtime.plan_completion_boundary_patch import apply_plan_completion_boundary_patch
    from harness_codex.runtime.procedure_stage_compatibility_patch import (
        apply_procedure_stage_compatibility_patch,
    )
    from harness_codex.runtime.dashboard_runtime_state import apply_dashboard_runtime_state_patch
    from harness_codex.runtime.changeset_deletion_runtime_patch import (
        apply_changeset_deletion_runtime_cleanup_patch,
    )
    from harness_codex.runtime.verification_repair_dashboard_patch import (
        install_verification_repair_dashboard_patch,
    )
    from harness_codex.runtime.dashboard_ddd_integration_patch import (
        apply_dashboard_ddd_integration_patch,
    )
    from harness_codex.runtime.grill_me_question_batch_patch import (
        apply_grill_me_question_batch_patch,
    )
    from harness_codex.runtime.main_session_progress_patch import (
        apply_main_session_progress_feedback_patch,
    )
    from harness_codex.runtime.agent_output_contract_patch import (
        apply_agent_output_contract_patch,
    )
    from harness_codex.runtime.agent_trace_retention_patch import (
        apply_agent_trace_retention_patch,
    )
    from harness_codex.runtime.token_observability_trace_retention_patch import (
        apply_token_observability_trace_retention_patch,
    )
    from harness_codex.runtime.ddd_candidate_efficiency_patch import (
        apply_ddd_candidate_efficiency_patch,
    )
    from harness_codex.runtime.ddd_candidate_input_integrity_patch import (
        apply_ddd_candidate_input_integrity_patch,
    )
    from harness_codex.runtime.ddd_integration_candidate_provenance_patch import (
        apply_ddd_integration_candidate_provenance_patch,
    )
    from harness_codex.runtime.agent_write_scope_policy_patch import (
        apply_agent_write_scope_policy_patch,
    )
    from harness_codex.runtime.scope_violation_recovery_patch import (
        apply_scope_violation_recovery_patch,
    )
    from harness_codex.runtime.procedure_stage_runtime_state_patch import (
        apply_procedure_stage_runtime_state_patch,
    )
    from harness_codex.runtime.temporary_changeset_canonical_state_patch import (
        apply_temporary_changeset_canonical_state_patch,
    )
    from harness_codex.runtime.dashboard_gate_state_patch import apply_dashboard_gate_state_patch
    from harness_codex.runtime.dashboard_final_design_result_patch import (
        apply_dashboard_final_design_result_patch,
    )
    from harness_codex.runtime.changeset_scope_isolation_patch import (
        apply_changeset_scope_isolation_patch,
    )
    from harness_codex.runtime.canonical_stage_gate_authority_patch import (
        apply_canonical_stage_gate_authority_patch,
    )
    from harness_codex.runtime.security_review_prompt_patch import (
        apply_security_review_prompt_patch,
    )

    apply_serena_mcp_patch()
    # Recovery UI wraps the DDD UI installer and must be registered first.
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
    apply_main_session_progress_feedback_patch()
    apply_agent_output_contract_patch()
    apply_agent_trace_retention_patch()
    apply_token_observability_trace_retention_patch()
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
