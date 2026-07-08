from pathlib import Path

from harness_codex import bug_cli, canonical_cli


def test_bug_start_creates_lightweight_maintenance_slice(tmp_path: Path) -> None:
    result = bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "start",
            "--title",
            "결제 중복 승인",
            "--symptom",
            "payment retry causes duplicate confirmation",
            "--severity",
            "critical",
            "--path",
            "purchase/src/main/java/Purchase.java",
        ]
    )

    assert result == 0
    bug_dirs = sorted((tmp_path / "docs/maintenance").glob("BUG-*"))
    assert len(bug_dirs) == 1
    bug_dir = bug_dirs[0]
    assert (bug_dir / "index.md").is_file()
    assert (bug_dir / "change-intent.md").is_file()
    assert (bug_dir / "verification-goal.md").is_file()
    assert (bug_dir / "triage.md").is_file()
    assert (bug_dir / "technical-decisions.md").is_file()
    assert "Workflow tier|incident" in (bug_dir / "index.md").read_text(encoding="utf-8")
    assert "memory/cache/graph 기반 탐색 결과" in (bug_dir / "index.md").read_text(encoding="utf-8")


def test_bug_plan_verify_and_complete(tmp_path: Path) -> None:
    assert bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "start",
            "--title",
            "목록 정렬 오류",
            "--symptom",
            "latest item appears last",
            "--severity",
            "low",
        ]
    ) == 0
    bug_id = next((tmp_path / "docs/maintenance").glob("BUG-*")).name

    assert bug_cli.main(["--repo-root", str(tmp_path), "triage", bug_id]) == 0
    assert bug_cli.main(["--repo-root", str(tmp_path), "plan", bug_id]) == 0
    assert bug_cli.main(["--repo-root", str(tmp_path), "verify", bug_id]) == 0
    assert bug_cli.main(["--repo-root", str(tmp_path), "complete", bug_id]) == 0

    plan = tmp_path / "docs/plans/active" / bug_id / "plan.md"
    assert plan.is_file()
    assert "실패 테스트 또는 재현 증거" in plan.read_text(encoding="utf-8")
    index = tmp_path / "docs/maintenance" / bug_id / "index.md"
    assert "|상태|completed|" in index.read_text(encoding="utf-8")


def test_public_help_includes_bug_workflow() -> None:
    help_text = canonical_cli.help_command("bug")

    assert "harness bug start" in help_text
    assert "memory" in help_text
    assert "graph" in help_text
