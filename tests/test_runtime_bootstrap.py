from __future__ import annotations

from pathlib import Path
import subprocess
import sys

REMOVED_BOOTSTRAP_PATCH_MODULES = (
    "agent_output_contract_patch.py",
    "agent_trace_retention_patch.py",
    "agent_write_scope_policy_patch.py",
    "canonical_stage_gate_authority_patch.py",
    "changeset_deletion_runtime_patch.py",
    "changeset_scope_isolation_patch.py",
    "dashboard_ddd_integration_patch.py",
    "dashboard_final_design_result_patch.py",
    "dashboard_gate_state_patch.py",
    "ddd_candidate_efficiency_patch.py",
    "ddd_candidate_input_integrity_patch.py",
    "ddd_integration_candidate_provenance_patch.py",
    "delivery_runner_patch.py",
    "grill_me_question_batch_patch.py",
    "interactive_agent_scope_validation_patch.py",
    "interactive_agent_transaction_patch.py",
    "main_session_progress_patch.py",
    "observability_patch.py",
    "plan_completion_boundary_patch.py",
    "plan_transition_policy_patch.py",
    "preflight_policy_patch.py",
    "procedure_stage_compatibility_patch.py",
    "procedure_stage_runtime_state_patch.py",
    "scope_violation_recovery_patch.py",
    "security_review_prompt_patch.py",
    "serena_patch.py",
    "step_transaction_patch.py",
    "temporary_changeset_canonical_state_patch.py",
    "token_observability_trace_retention_patch.py",
    "verification_repair_dashboard_patch.py",
    "xml_state_store_patch.py",
)


def _run(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", code],
        text=True,
        capture_output=True,
        check=False,
    )


def test_importing_cli_does_not_install_changeset_boundary() -> None:
    completed = _run(
        "import harness_codex.cli as cli; "
        "assert not getattr(cli, '_changeset_execution_boundary_installed', False)"
    )

    assert completed.returncode == 0, completed.stderr


def test_explicit_bootstrap_does_not_replace_execution_callables() -> None:
    completed = _run(
        "import harness_codex.cli as cli; "
        "import harness_codex.runtime.changeset_orchestrator as orchestrator; "
        "cli_original = cli._apply_workflow; "
        "coordinator_original = orchestrator.apply_workflow; "
        "from harness_codex.bootstrap import configure_runtime; "
        "installation = configure_runtime(); "
        "assert cli._apply_workflow is cli_original; "
        "assert orchestrator.apply_workflow is coordinator_original; "
        "assert not getattr(cli, '_changeset_execution_boundary_installed', False); "
        "assert 'verification-report' in installation.registered_schemas; "
        "assert 'verdict-status-present' in installation.registered_gates"
    )

    assert completed.returncode == 0, completed.stderr


def test_bootstrap_does_not_import_patch_modules() -> None:
    completed = _run(
        "import sys; "
        "from harness_codex.bootstrap import configure_runtime; "
        "configure_runtime(); "
        "assert not [name for name in sys.modules if name.startswith('harness_codex.runtime.') and name.endswith('_patch')]"
    )

    assert completed.returncode == 0, completed.stderr


def test_removed_bootstrap_patch_modules_do_not_exist() -> None:
    runtime_dir = Path("harness_codex/runtime")

    assert all(not (runtime_dir / name).exists() for name in REMOVED_BOOTSTRAP_PATCH_MODULES)


def test_public_entrypoint_uses_session_coordinator() -> None:
    completed = _run(
        "import harness_codex.entrypoint as entrypoint; "
        "assert entrypoint.apply_workflow.__module__ == "
        "'harness_codex.runtime.session_coordinator'"
    )

    assert completed.returncode == 0, completed.stderr
