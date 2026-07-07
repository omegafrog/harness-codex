"""Explicit composition root for optional runtime extensions.

The core package and the runtime export module are deliberately import-safe.
Executable entry points call :func:`configure_runtime` once before dispatching
commands. This keeps historical compatibility hooks contained at one boundary
while they are gradually absorbed into their owning modules.
"""

from __future__ import annotations

from threading import Lock

_configure_lock = Lock()
_configured = False


def configure_runtime() -> None:
    """Install runtime extensions once for an executable harness session.

    This is a transitional composition root. Individual compatibility hooks are
    removed from this list only after their behavior is incorporated into the
    relevant core module with focused regression coverage.
    """

    global _configured
    if _configured:
        return
    with _configure_lock:
        if _configured:
            return
        _install_runtime_extensions()
        _configured = True


def _install_runtime_extensions() -> None:
    # Runtime-core extensions. Keep the former runtime initializer order so
    # existing hooks that still depend on a prior extension retain behavior.
    from harness_codex.runtime.serena_patch import apply_serena_mcp_patch
    from harness_codex.runtime.observability_patch import apply_observability_patch
    from harness_codex.runtime.delivery_runner_patch import apply_delivery_runner_patch
    from harness_codex.runtime.plan_transition_policy_patch import (
        apply_plan_transition_policy_patch,
    )
    from harness_codex.runtime.plan_completion_boundary_patch import (
        apply_plan_completion_boundary_patch,
    )
    from harness_codex.runtime.procedure_stage_compatibility_patch import (
        apply_procedure_stage_compatibility_patch,
    )
    from harness_codex.runtime.dashboard_runtime_state import apply_dashboard_runtime_state_patch
    from harness_codex.runtime.dashboard_runtime_state_legacy_bridge import (
        apply_dashboard_runtime_state_legacy_bridge,
    )
    from harness_codex.runtime.dashboard_runtime_state_legacy_compat import (
        apply_dashboard_runtime_state_legacy_compat,
    )
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

    apply_serena_mcp_patch()
    # The recovery UI hook wraps the DDD UI installer, so it must be installed
    # before the DDD installer executes.
    install_verification_repair_dashboard_patch()
    apply_observability_patch()
    apply_delivery_runner_patch()
    apply_plan_transition_policy_patch()
    apply_plan_completion_boundary_patch()
    apply_procedure_stage_compatibility_patch()
    apply_dashboard_runtime_state_patch()
    apply_dashboard_runtime_state_legacy_bridge()
    apply_dashboard_runtime_state_legacy_compat()
    apply_changeset_deletion_runtime_cleanup_patch()
    apply_dashboard_ddd_integration_patch()
    apply_grill_me_question_batch_patch()

    # Session and workflow extensions formerly installed by the package root.
    # They remain centralized here until their owning coordinator/state modules
    # replace the remaining method-replacement implementations.
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

    apply_main_session_progress_feedback_patch()
    apply_agent_output_contract_patch()
    apply_agent_trace_retention_patch()
    apply_token_observability_trace_retention_patch()
    apply_ddd_candidate_efficiency_patch()
    apply_ddd_candidate_input_integrity_patch()
    apply_ddd_integration_candidate_provenance_patch()
    _install_changeset_execution_boundary()
    apply_agent_write_scope_policy_patch()
    apply_scope_violation_recovery_patch()
    apply_procedure_stage_runtime_state_patch()
    apply_temporary_changeset_canonical_state_patch()
    apply_dashboard_gate_state_patch()
    apply_dashboard_final_design_result_patch()
    apply_changeset_scope_isolation_patch()
    apply_canonical_stage_gate_authority_patch()
    apply_security_review_prompt_patch()


def _install_changeset_execution_boundary() -> None:
    """Bridge the legacy CLI handler to the canonical session orchestrator.

    The bridge remains explicit rather than import-time. It is removed in the
    next extraction when ``cli.py`` delegates directly to the coordinator.
    """

    from harness_codex import cli
    from harness_codex.runtime.changeset_orchestrator import apply_workflow

    if getattr(cli, "_changeset_execution_boundary_installed", False):
        return

    def load_session_workflow(*loader_args, **loader_kwargs):
        workflow = cli.load_named_workflow(*loader_args, **loader_kwargs)
        if not hasattr(workflow, "steps"):
            setattr(workflow, "steps", ())
        return workflow

    def run_session(*args, **kwargs):
        return apply_workflow(
            *args,
            **kwargs,
            workflow_loader=load_session_workflow,
            workflow_materializer=cli.materialize_workflow_for_scope,
            manifest_writer=cli.write_materialized_workflow_manifest,
            engine_factory=lambda: cli.RunnerEngine(cli.BasicStepRunner()),
            emit=print,
        )

    cli._apply_workflow = run_session
    cli._changeset_execution_boundary_installed = True
