from __future__ import annotations

import subprocess
from pathlib import Path

import harness_codex.runtime.change_set_pr_delivery as pr_delivery
from harness_codex.runtime.verify_work_item import verify_work_item


def test_documentation_work_item_skips_repository_test_gate_but_requires_document_evidence(
    tmp_path: Path,
) -> None:
    _write_changeset(
        tmp_path,
        work_item_id="MAINT-100",
        work_item_type="maintenance",
        impact_type="documentation",
        slice_path="docs/maintenance/MAINT-100/",
    )
    plan = tmp_path / "docs/plans/active/MAINT-100/plan.md"
    goal = tmp_path / "docs/maintenance/MAINT-100/verification-goal.md"
    plan.parent.mkdir(parents=True)
    goal.parent.mkdir(parents=True)
    plan.write_text("- [x] Documentation: verified links and examples\n", encoding="utf-8")
    goal.write_text("Documentation review is required.\n", encoding="utf-8")
    gate = tmp_path / ".codex/test-gate.yaml"
    gate.parent.mkdir(parents=True)
    gate.write_text(
        "required:\n  - command: python3 -c \"raise SystemExit(99)\"\n",
        encoding="utf-8",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-100",
        work_item_id="MAINT-100",
        run_id="run-100",
    )

    assert result.passed
    assert result.command_results == ()
    assert result.document_evidence == ("plan: Documentation: verified links and examples",)


def test_ui_work_item_fails_without_browser_and_runtime_command_evidence(tmp_path: Path) -> None:
    _write_changeset(
        tmp_path,
        work_item_id="UC-200",
        work_item_type="feature_extension",
        impact_type="ui, user-feature",
        slice_path="docs/use-cases/UC-200/",
    )
    plan = tmp_path / "docs/plans/active/UC-200/plan.md"
    goal = tmp_path / "docs/use-cases/UC-200/e2e-goal.md"
    plan.parent.mkdir(parents=True)
    goal.parent.mkdir(parents=True)
    plan.write_text("- [x] Tests: `.codex/test-gate.yaml`\n", encoding="utf-8")
    goal.write_text(
        "|Step|Command|Success|Required|\n|---|---|---|---|\n"
        "|E2E|`python3 -c \"print('e2e')\"`|exit code 0|required|\n",
        encoding="utf-8",
    )
    gate = tmp_path / ".codex/test-gate.yaml"
    gate.parent.mkdir(parents=True)
    gate.write_text(
        "required:\n  - name: unit\n    command: python3 -c \"print('unit')\"\n",
        encoding="utf-8",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-200",
        work_item_id="UC-200",
        run_id="run-200",
    )

    assert result.passed is False
    assert "browser-ui: required command evidence is missing" in result.missing_obligations
    assert "runtime-server: required command evidence is missing" in result.missing_obligations


def test_observed_delivery_paths_include_committed_branch_diff(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-b", "main")
    _git(tmp_path, "config", "user.name", "Harness Test")
    _git(tmp_path, "config", "user.email", "harness@example.test")
    source = tmp_path / "src/auth/token_validator.py"
    source.parent.mkdir(parents=True)
    source.write_text("VERSION = 1\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "base")
    _git(tmp_path, "checkout", "-b", "feature/policy")
    source.write_text("VERSION = 2\n", encoding="utf-8")
    _git(tmp_path, "add", "src/auth/token_validator.py")
    _git(tmp_path, "commit", "-m", "security change")

    observed = pr_delivery._observed_delivery_paths(tmp_path, "main", ())

    assert observed == ("src/auth/token_validator.py",)


def test_observed_delivery_paths_ignore_base_only_advancement(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-b", "main")
    _git(tmp_path, "config", "user.name", "Harness Test")
    _git(tmp_path, "config", "user.email", "harness@example.test")
    source = tmp_path / "src/allowed/service.py"
    source.parent.mkdir(parents=True)
    source.write_text("VERSION = 1\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "base")
    _git(tmp_path, "checkout", "-b", "feature/policy")
    source.write_text("VERSION = 2\n", encoding="utf-8")
    _git(tmp_path, "add", "src/allowed/service.py")
    _git(tmp_path, "commit", "-m", "feature change")
    _git(tmp_path, "checkout", "main")
    advanced = tmp_path / "src/unrelated/base_only.py"
    advanced.parent.mkdir(parents=True)
    advanced.write_text("BASE_ONLY = True\n", encoding="utf-8")
    _git(tmp_path, "add", "src/unrelated/base_only.py")
    _git(tmp_path, "commit", "-m", "base advancement")
    _git(tmp_path, "checkout", "feature/policy")

    observed = pr_delivery._observed_delivery_paths(tmp_path, "main", ())

    assert observed == ("src/allowed/service.py",)


def _write_changeset(
    repo_root: Path,
    *,
    work_item_id: str,
    work_item_type: str,
    impact_type: str,
    slice_path: str,
) -> None:
    path = repo_root / "docs/changes/active/CHG-" / "placeholder"
    del path
    change_set = repo_root / "docs/changes/active" / (
        "CHG-100.md" if work_item_id == "MAINT-100" else "CHG-200.md"
    )
    change_set.parent.mkdir(parents=True, exist_ok=True)
    change_set.write_text(
        "\n".join(
            (
                f"# ChangeSet {change_set.stem}",
                "",
                "## 1. Metadata",
                "|Item|Value|",
                "|---|---|",
                f"|ChangeSet ID|`{change_set.stem}`|",
                "|Status|active|",
                "",
                "## 5. Affected Work Items",
                "|Work Item ID|Type|Name|Impact Type|Slice Path|Status|",
                "|---|---|---|---|---|---|",
                f"|`{work_item_id}`|{work_item_type}|Policy test|{impact_type}|`{slice_path}`|planned|",
                "",
            )
        ),
        encoding="utf-8",
    )


def _git(repo_root: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=True,
    )
