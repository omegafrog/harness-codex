from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_runtime_version_bump_runs_for_main_push_without_recursing() -> None:
    workflow = (
        ROOT / ".github/workflows/bump-runtime-version.yml"
    ).read_text(encoding="utf-8")

    assert "  push:\n    branches: [main]" in workflow
    assert "  pull_request:" not in workflow
    assert "!startsWith(github.event.head_commit.message" in workflow
    assert "chore: 런타임 패치 버전 자동 증가" in workflow
    assert "python3 scripts/bump_runtime_version.py" in workflow
    assert "git push origin HEAD:main" in workflow
