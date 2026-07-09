import json
from pathlib import Path
import subprocess

from harness_codex import bug_cli, canonical_cli


def _init_git_repo(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "초기 커밋"], cwd=path, check=True, capture_output=True)


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
    assert (bug_dir / "index.xml").is_file()
    assert (bug_dir / "change-intent.md").is_file()
    assert (bug_dir / "verification-goal.md").is_file()
    assert (bug_dir / "triage.md").is_file()
    assert (bug_dir / "technical-decisions.md").is_file()
    index = (bug_dir / "index.xml").read_text(encoding="utf-8")
    assert "<workflow-tier>incident</workflow-tier>" in index
    assert '<document path="triage.md" status="draft">' in index
    assert "<purpose>memory/cache/graph 기반 탐색 결과</purpose>" in index


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
    index = tmp_path / "docs/maintenance" / bug_id / "index.xml"
    assert "<status>completed</status>" in index.read_text(encoding="utf-8")


def test_public_help_includes_bug_workflow() -> None:
    help_text = canonical_cli.help_command("bug")

    assert "harness bug start" in help_text
    assert "harness bug run BUG-ID" in help_text
    assert "memory" in help_text
    assert "graph" in help_text


def test_bug_run_completes_with_single_successful_loop(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    assert bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "start",
            "--title",
            "파일 없음",
            "--symptom",
            "missing file",
        ]
    ) == 0
    bug_id = next((tmp_path / "docs/maintenance").glob("BUG-*")).name
    assert bug_cli.main(["--repo-root", str(tmp_path), "plan", bug_id]) == 0

    result = bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "run",
            bug_id,
            "--implement-command",
            "mkdir -p src && printf 'ok\\n' > src/fix.txt",
            "--verify-command",
            "test -f src/fix.txt",
        ]
    )

    assert result == 0
    index = (tmp_path / "docs/maintenance" / bug_id / "index.xml").read_text(encoding="utf-8")
    assert "<status>completed</status>" in index
    loop_state = json.loads((tmp_path / "docs/maintenance" / bug_id / "loop-state.json").read_text(encoding="utf-8"))
    assert loop_state["status"] == "completed"
    worktree_root = Path(loop_state["worktree_root"])
    assert (worktree_root / "src/fix.txt").is_file()
    assert not (tmp_path / "src/fix.txt").exists()


def test_bug_run_blocks_after_repeated_failure_fingerprint(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    assert bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "start",
            "--title",
            "반복 실패",
            "--symptom",
            "repeat failure",
        ]
    ) == 0
    bug_id = next((tmp_path / "docs/maintenance").glob("BUG-*")).name
    assert bug_cli.main(["--repo-root", str(tmp_path), "plan", bug_id]) == 0

    result = bug_cli.main(
        [
            "--repo-root",
            str(tmp_path),
            "run",
            bug_id,
            "--implement-command",
            "true",
            "--verify-command",
            "false",
            "--max-loops",
            "2",
        ]
    )

    assert result == 2
    index = (tmp_path / "docs/maintenance" / bug_id / "index.xml").read_text(encoding="utf-8")
    assert "<status>blocked</status>" in index
    loop_state = json.loads((tmp_path / "docs/maintenance" / bug_id / "loop-state.json").read_text(encoding="utf-8"))
    assert loop_state["status"] == "blocked"
    assert loop_state["worktree_root"]
