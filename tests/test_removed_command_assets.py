from __future__ import annotations

import shutil
from pathlib import Path

from harness_codex.runtime.runtime_services import install_runtime_services


FORBIDDEN_COMMANDS = (
    " ".join(("harness", "implementation")),
    " ".join(("changes", "continue")),
)
ASSET_SUFFIXES = {".md", ".toml", ".yaml", ".yml", ".json", ".py", ".sh", ".js"}


def _asset_text(root: Path) -> str:
    chunks: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in ASSET_SUFFIXES:
            continue
        if any(part in {".git", "venv", "__pycache__"} for part in path.parts):
            continue
        chunks.append(path.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(chunks)


def _assert_removed_commands_absent(root: Path) -> None:
    text = _asset_text(root)
    assert all(command not in text for command in FORBIDDEN_COMMANDS)


def test_removed_commands_are_absent_from_source_assets() -> None:
    _assert_removed_commands_absent(Path(__file__).parents[1])


def test_removed_commands_are_absent_from_installed_assets(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    installed = tmp_path / "installed"
    shutil.copytree(source / ".codex", installed / ".codex")
    shutil.copytree(source / "harness_codex", installed / "harness_codex")
    shutil.copy2(source / "README.md", installed / "README.md")
    install_runtime_services(installed)

    _assert_removed_commands_absent(installed)
