import subprocess
from pathlib import Path

from harness_codex.runtime.change_set_pr_delivery import _observed_delivery_paths


def test_observed_delivery_paths_use_final_diff_not_branch_history(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-b", "main")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "테스트")
    (tmp_path / "README.md").write_text("base\n", encoding="utf-8")
    _git(tmp_path, "add", "README.md")
    _git(tmp_path, "commit", "-m", "초기")
    _git(tmp_path, "checkout", "-b", "feature")

    transient = tmp_path / "docs/use-cases/UC-002/use-case.md"
    transient.parent.mkdir(parents=True)
    transient.write_text("임시\n", encoding="utf-8")
    _git(tmp_path, "add", "docs/use-cases/UC-002/use-case.md")
    _git(tmp_path, "commit", "-m", "임시 추가")
    _git(tmp_path, "rm", "docs/use-cases/UC-002/use-case.md")
    _git(tmp_path, "commit", "-m", "임시 제거")

    retained = tmp_path / "docs/design/요구사항.md"
    retained.parent.mkdir(parents=True, exist_ok=True)
    retained.write_text("변경\n", encoding="utf-8")
    _git(tmp_path, "add", "docs/design/요구사항.md")
    _git(tmp_path, "commit", "-m", "요구사항 변경")

    paths = _observed_delivery_paths(tmp_path, "main", ())

    assert "docs/design/요구사항.md" in paths
    assert "docs/use-cases/UC-002/use-case.md" not in paths


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        text=True,
        capture_output=True,
    )
