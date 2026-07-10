from __future__ import annotations

from pathlib import Path
import subprocess
import sys

REMOVED_BOOTSTRAP_PATCH_MODULES = (
    "agent_output_contract_patch.py",
    "agent_trace_reference_cleanup_patch.py",
    "agent_trace_retention_patch.py",
    "agent_write_scope_policy_patch.py",
    "canonical_stage_gate_authority_patch.py",
    "changeset_deletion_runtime_patch.py",
    "changeset_scope_isolation_patch.py",
    "dashboard_ddd_integration_patch.py",
    "dashboard_ddd_integration_rerun_patch.py",
    "dashboard_ddd_integration_ui_patch.py",
    "dashboard_final_design_result_patch.py",
    "dashboard_gate_state_patch.py",
    "ddd_candidate_baseline_provenance_patch.py",
    "ddd_candidate_efficiency_patch.py",
    "ddd_candidate_input_integrity_patch.py",
    "ddd_candidate_rollback_patch.py",
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
    "procedure_stage_runtime_state_preservation_patch.py",
    "scope_violation_recovery_patch.py",
    "security_review_prompt_patch.py",
    "serena_patch.py",
    "step_transaction_patch.py",
    "temporary_changeset_canonical_state_patch.py",
    "token_observability_trace_retention_patch.py",
    "verification_repair_dashboard_patch.py",
    "xml_changeset_template_patch.py",
    "xml_completion_gate_patch.py",
    "xml_document_dashboard_patch.py",
    "xml_finalization_report_patch.py",
    "xml_gate_authority_patch.py",
    "xml_harvest_state_patch.py",
    "xml_orchestrator_state_patch.py",
    "xml_review_gate_patch.py",
    "xml_runtime_state_patch.py",
    "xml_state_store_patch.py",
    "xml_step_ledger_patch.py",
    "xml_ui_evidence_patch.py",
    "xml_ui_state_patch.py",
    "xml_verification_engine_patch.py",
)

REMOVED_REPOSITORY_PATCH_INSTALLER_PATHS = (
    Path("harness_codex/runtime/repository_patches/__init__.py"),
    Path("harness_codex/runtime/repository_patches/__main__.py"),
    Path("harness_codex/runtime/repository_patches/apply.py"),
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
        "cli_original = cli._apply_workflow; "
        "from harness_codex.bootstrap import configure_runtime; "
        "installation = configure_runtime(); "
        "assert cli._apply_workflow is cli_original; "
        "assert not getattr(cli, '_changeset_execution_boundary_installed', False); "
        "assert 'runtime-tool-request-v1' in installation.registered_schemas; "
        "assert 'runtime-tool-result-v1' in installation.registered_schemas; "
        "assert 'verdict-status-present' in installation.registered_gates"
    )

    assert completed.returncode == 0, completed.stderr


def test_public_support_exports_runtime_step_boundaries_without_patch_installation() -> None:
    completed = _run(
        "from harness_codex.runtime import LocalStepRunner; "
        "assert LocalStepRunner.__name__ == 'LocalStepRunner'"
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


def test_repository_patch_installer_does_not_exist() -> None:
    assert all(not path.exists() for path in REMOVED_REPOSITORY_PATCH_INSTALLER_PATHS)


def test_installer_script_does_not_run_repository_patches() -> None:
    installer = Path("scripts/install-harness-codex.sh").read_text(encoding="utf-8")

    assert "apply_repository_patches" not in installer
    assert "harness_codex.runtime.repository_patches" not in installer


def test_public_entrypoint_does_not_expose_session_orchestration() -> None:
    completed = _run(
        "import harness_codex.entrypoint as entrypoint; "
        "assert not hasattr(entrypoint, 'apply_workflow'); "
        "assert not hasattr(entrypoint, 'ChangeSetSessionCoordinator')"
    )

    assert completed.returncode == 0, completed.stderr


def test_removed_public_orchestration_commands_fail_closed() -> None:
    completed = _run(
        "from harness_codex import canonical_cli; "
        "from harness_codex import cli; "
        "assert 'implementation' not in canonical_cli.PUBLIC_COMMANDS; "
        "assert all(name != 'implementation' for name, _summary in cli.COMMAND_HELP); "
        "assert 'continue' not in cli.TOPIC_HELP['changes']"
    )

    assert completed.returncode == 0, completed.stderr
