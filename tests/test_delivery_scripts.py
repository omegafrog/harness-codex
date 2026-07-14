from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[1]
CHECK = ROOT / ".codex/skills/harness-delivery-repository-check/scripts/check_repositories.py"
ISSUE = ROOT / ".codex/skills/harness-delivery-issue/scripts/create_issue.py"


def _plan(path: Path, rows: str = "| frontend | 화면 구현 | 화면 검증 |\n") -> Path:
    plan = path / "docs/changes/active/CHG-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        "# 구현 계획\n\n## 외부 저장소 전달\n\n| 저장소 | 범위 | 성공 기준 |\n| --- | --- | --- |\n"
        + rows,
        encoding="utf-8",
    )
    return plan


def test_repository_check_blocks_when_map_is_missing(tmp_path: Path) -> None:
    completed = subprocess.run(
        ["python3", str(CHECK), "--repo-root", str(tmp_path), "--plan", str(_plan(tmp_path))],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert json.loads(completed.stdout)["status"] == "blocked"


def test_repository_check_accepts_initialized_mapped_repository(tmp_path: Path) -> None:
    target = tmp_path / "frontend"
    for required in (
        ".codex/skills/harness-orchestrate-instruction",
        ".codex/workflow",
        "harness_codex",
    ):
        (target / required).mkdir(parents=True, exist_ok=True)
    (target / ".codex/skills/harness-orchestrate-instruction/SKILL.md").write_text("ok", encoding="utf-8")
    (target / ".codex/workflow/token-estimation.md").write_text("ok", encoding="utf-8")
    (target / "harness").write_text("ok", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    mapping = tmp_path / ".harness/repositories.toml"
    mapping.parent.mkdir()
    mapping.write_text(
        '[[repository]]\n'
        'id = "frontend"\n'
        'path = "frontend"\n'
        'github = "owner/frontend"\n',
        encoding="utf-8",
    )

    completed = subprocess.run(
        ["python3", str(CHECK), "--repo-root", str(tmp_path), "--plan", str(_plan(tmp_path))],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert json.loads(completed.stdout)["repositories"][0]["ready"] is True


def test_repository_check_marks_uninitialized_repository_for_bootstrap(tmp_path: Path) -> None:
    target = tmp_path / "frontend"
    target.mkdir()
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    mapping = tmp_path / ".harness/repositories.toml"
    mapping.parent.mkdir()
    mapping.write_text(
        '[[repository]]\n'
        'id = "frontend"\n'
        'path = "frontend"\n'
        'github = "owner/frontend"\n',
        encoding="utf-8",
    )

    completed = subprocess.run(
        ["python3", str(CHECK), "--repo-root", str(tmp_path), "--plan", str(_plan(tmp_path))],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert json.loads(completed.stdout)["repositories"][0]["bootstrap_required"] is True


def test_issue_script_dry_run_requires_marker(tmp_path: Path) -> None:
    body = tmp_path / "issue.md"
    body.write_text("Harness-ChangeSet: CHG-001\nHarness-Delivery-Kind: bootstrap\n", encoding="utf-8")

    completed = subprocess.run(
        [
            "python3", str(ISSUE), "--repository", "owner/frontend", "--changeset", "CHG-001",
            "--kind", "bootstrap", "--title", "제목", "--body-file", str(body), "--dry-run",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert json.loads(completed.stdout)["status"] == "planned"
