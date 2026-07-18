from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


SCRIPT = Path(".codex/skills/harness-codedeploy-pipeline/scripts/reconcile_codedeploy.py").resolve()


def _run(root: Path, run_id: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--repo-root",
            str(root),
            "--run-id",
            run_id,
            *args,
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def test_reconcile_creates_then_passes_unchanged_without_rewrite(tmp_path: Path) -> None:
    (tmp_path / "appspec.yml").write_text("version: 0.0\n", encoding="utf-8")

    created = _run(tmp_path, "run-1", "--pipeline", "codedeploy")
    workflow = tmp_path / ".github/workflows/codedeploy.yml"
    first = workflow.read_bytes()
    unchanged = _run(tmp_path, "run-2", "--pipeline", "codedeploy")

    assert created.returncode == 0
    assert json.loads(created.stdout)["status"] == "created"
    assert unchanged.returncode == 0
    assert json.loads(unchanged.stdout)["status"] == "unchanged"
    assert workflow.read_bytes() == first
    text = first.decode()
    assert isinstance(yaml.safe_load(text), dict)
    assert "push:\n    branches: [main]" in text
    assert "id-token: write" in text
    assert "aws-actions/configure-aws-credentials@v6" in text
    assert 'state" == "stopped"' in text
    assert "aws deploy wait deployment-successful" in text
    assert "PublicDnsName" in text
    assert 'curl --fail --show-error --retry 10' in text


def test_reconcile_updates_only_when_contract_changes(tmp_path: Path) -> None:
    (tmp_path / "appspec.yml").write_text("version: 0.0\n", encoding="utf-8")
    assert _run(tmp_path, "run-1", "--pipeline", "codedeploy").returncode == 0

    updated = _run(
        tmp_path,
        "run-2",
        "--pipeline",
        "codedeploy",
        "--package-command",
        'tar -czf "$REVISION_FILE" .',
    )

    assert updated.returncode == 0
    assert json.loads(updated.stdout)["status"] == "updated"
    assert 'tar -czf "$REVISION_FILE" .' in (
        tmp_path / ".github/workflows/codedeploy.yml"
    ).read_text(encoding="utf-8")


def test_reconcile_preserves_user_owned_workflow(tmp_path: Path) -> None:
    (tmp_path / "appspec.yml").write_text("version: 0.0\n", encoding="utf-8")
    workflow = tmp_path / ".github/workflows/codedeploy.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text("name: custom\n", encoding="utf-8")

    result = _run(tmp_path, "run-1", "--pipeline", "codedeploy")

    assert result.returncode == 2
    assert json.loads(result.stdout)["status"] == "conflict"
    assert workflow.read_text(encoding="utf-8") == "name: custom\n"


def test_reconcile_none_is_skipped_and_does_not_touch_workflow(tmp_path: Path) -> None:
    result = _run(tmp_path, "run-1", "--pipeline", "none")

    assert result.returncode == 0
    assert json.loads(result.stdout)["status"] == "skipped"
    assert not (tmp_path / ".github/workflows/codedeploy.yml").exists()
