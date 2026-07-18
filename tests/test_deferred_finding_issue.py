from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / ".codex/skills/harness-deferred-findings/scripts/create_issue.py"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("create_deferred_issue", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def _run(body: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--repository",
            "owner/repo",
            "--changeset",
            "CHG-001",
            "--finding-id",
            "F-01",
            "--title",
            "후속 검증",
            "--body-file",
            str(body),
            *extra,
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def test_issue_creation_requires_explicit_user_approval(tmp_path: Path) -> None:
    body = tmp_path / "body.md"
    body.write_text("Harness-Deferred-Finding: CHG-001:F-01\n", encoding="utf-8")

    result = _run(body, "--dry-run")

    assert result.returncode == 2
    assert "사용자 승인 없이" in result.stderr


def test_approved_dry_run_requires_stable_marker(tmp_path: Path) -> None:
    body = tmp_path / "body.md"
    body.write_text("marker 없음\n", encoding="utf-8")
    rejected = _run(body, "--user-approved", "--dry-run")
    assert rejected.returncode == 2

    body.write_text("Harness-Deferred-Finding: CHG-001:F-01\n", encoding="utf-8")
    planned = _run(body, "--user-approved", "--dry-run")
    assert planned.returncode == 0
    assert '"status": "planned"' in planned.stdout


def test_existing_issue_is_reused_by_marker_not_title() -> None:
    module = _load_script()
    marker = module.finding_marker("CHG-001", "F-01")
    issues = [
        {"title": "같은 제목", "body": "다른 finding", "url": "https://invalid"},
        {"title": "다른 제목", "body": marker, "url": "https://example.test/1"},
    ]

    assert module.reusable_issue(issues, marker) == "https://example.test/1"
