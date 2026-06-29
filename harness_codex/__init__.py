"""Runtime support package for harness-codex."""

from __future__ import annotations

from importlib import import_module

__all__ = ["__version__"]

__version__ = "0.1.164"


def _install_changeset_execution_boundary() -> None:
    """Route the CLI hook through the two-layer ChangeSet session orchestrator.

    The public parser and injected test doubles stay stable while execution moves
    from one mixed workflow to explicit work-item and finalization boundaries.
    """

    cli = import_module("harness_codex.cli")
    if getattr(cli, "_changeset_execution_boundary_installed", False):
        return

    from harness_codex.runtime.changeset_orchestrator import apply_workflow

    def load_session_workflow(*loader_args, **loader_kwargs):
        """Load a runtime workflow while retaining the command test seam.

        Production loaders return a ``Workflow`` with concrete steps. Older command
        tests inject a named mutable handle only; normalize that handle so boundary
        validation can still run over its empty test-step set without weakening the
        validation of production workflow definitions.
        """
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


def _install_runtime_write_boundaries() -> None:
    """Install declared write scopes before fail-closed violation recovery."""

    from harness_codex.runtime.agent_write_scope_policy_patch import (
        apply_agent_write_scope_policy_patch,
    )
    from harness_codex.runtime.scope_violation_recovery_patch import (
        apply_scope_violation_recovery_patch,
    )

    apply_agent_write_scope_policy_patch()
    apply_scope_violation_recovery_patch()


def _install_canonical_procedure_stage_bridge() -> None:
    """Install canonical state bridges after the CLI module is complete."""

    from harness_codex.runtime.dashboard_final_design_result_patch import (
        apply_dashboard_final_design_result_patch,
    )
    from harness_codex.runtime.dashboard_gate_state_patch import (
        apply_dashboard_gate_state_patch,
    )
    from harness_codex.runtime.procedure_stage_runtime_state_patch import (
        apply_procedure_stage_runtime_state_patch,
    )
    from harness_codex.runtime.temporary_changeset_canonical_state_patch import (
        apply_temporary_changeset_canonical_state_patch,
    )

    apply_procedure_stage_runtime_state_patch()
    apply_temporary_changeset_canonical_state_patch()
    apply_dashboard_gate_state_patch()
    apply_dashboard_final_design_result_patch()


def _install_changeset_deletion_cleanup() -> None:
    """Install deletion cleanup after the legacy CLI module is fully defined."""

    from harness_codex.runtime.changeset_deletion_runtime_patch import (
        apply_changeset_deletion_runtime_cleanup_patch,
    )

    apply_changeset_deletion_runtime_cleanup_patch()


def _install_changeset_scope_isolation() -> None:
    """Keep global harvest artifacts scoped to the currently active ChangeSet."""

    from harness_codex.runtime.changeset_scope_isolation_patch import (
        apply_changeset_scope_isolation_patch,
    )

    apply_changeset_scope_isolation_patch()


def _install_final_canonical_gate_authority() -> None:
    """Ensure explicit RunState decisions always outrank editable table rows."""

    from harness_codex.runtime.canonical_stage_gate_authority_patch import (
        apply_canonical_stage_gate_authority_patch,
    )

    apply_canonical_stage_gate_authority_patch()


def _install_security_review_bundle_prompt_profile() -> None:
    """Install minimal prompt handling for bundle-scoped security reviewers."""

    from harness_codex.runtime.security_review_prompt_patch import (
        apply_security_review_prompt_patch,
    )

    apply_security_review_prompt_patch()


_install_changeset_execution_boundary()
_install_runtime_write_boundaries()
_install_canonical_procedure_stage_bridge()
_install_changeset_deletion_cleanup()
_install_changeset_scope_isolation()
_install_final_canonical_gate_authority()
_install_security_review_bundle_prompt_profile()
