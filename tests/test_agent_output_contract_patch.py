from pathlib import Path
from types import SimpleNamespace

from harness_codex.runtime.agent_output_contract_patch import _validate_declared_output_shapes


def _step(*outputs: str):
    return SimpleNamespace(outputs=tuple(Path(path) for path in outputs))


def test_rejects_empty_declared_markdown_output(tmp_path: Path) -> None:
    output = tmp_path / "docs" / "candidate.md"
    output.parent.mkdir(parents=True)
    output.write_text("", encoding="utf-8")

    assert _validate_declared_output_shapes(_step("docs/candidate.md"), tmp_path) == "agent output must not be empty: docs/candidate.md"


def test_rejects_directory_for_declared_file_output(tmp_path: Path) -> None:
    (tmp_path / "docs" / "candidate.md").mkdir(parents=True)

    assert _validate_declared_output_shapes(_step("docs/candidate.md"), tmp_path) == "agent output must be a regular file: docs/candidate.md"


def test_accepts_nonempty_declared_directory_output(tmp_path: Path) -> None:
    (tmp_path / "docs" / "use-cases").mkdir(parents=True)

    assert _validate_declared_output_shapes(_step("docs/use-cases"), tmp_path) is None
