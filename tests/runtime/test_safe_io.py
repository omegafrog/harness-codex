from pathlib import Path

from harness_codex.runtime.safe_io import (
    apply_safe_utf8_write_patch,
    safe_utf8_text,
    write_utf8_text,
)


def test_safe_utf8_text_escapes_lone_surrogate() -> None:
    assert safe_utf8_text("prefix \ud83d suffix") == "prefix \\ud83d suffix"


def test_write_utf8_text_allows_lone_surrogate(tmp_path: Path) -> None:
    path = tmp_path / "surrogate.txt"

    write_utf8_text(path, "hello \ud83d")

    assert path.read_text(encoding="utf-8") == "hello \\ud83d"


def test_runtime_patch_makes_path_write_text_surrogate_safe(tmp_path: Path) -> None:
    apply_safe_utf8_write_patch()
    path = tmp_path / "patched.txt"

    path.write_text("hello \ud83d", encoding="utf-8")

    assert path.read_text(encoding="utf-8") == "hello \\ud83d"
