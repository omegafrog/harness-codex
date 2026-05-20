"""Safe text I/O helpers for runtime-generated artifacts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

_ORIGINAL_WRITE_TEXT = Path.write_text
_PATCHED = False


def safe_utf8_text(text: str) -> str:
    """Return text that can always be encoded as UTF-8.

    Runtime artifacts may contain lone surrogate code points from copied input,
    terminal output, or model output. Those characters cannot be encoded by the
    default UTF-8 encoder and would otherwise raise UnicodeEncodeError. Preserve
    them in a readable escaped form instead of crashing the run.
    """

    return text.encode("utf-8", errors="backslashreplace").decode("utf-8")


def write_utf8_text(path: Path, text: str) -> int:
    """Write UTF-8 text while escaping unencodable surrogate code points."""

    return _ORIGINAL_WRITE_TEXT(path, safe_utf8_text(text), encoding="utf-8")


def apply_safe_utf8_write_patch() -> None:
    """Patch Path.write_text so runtime UTF-8 writes tolerate surrogates."""

    global _PATCHED
    if _PATCHED:
        return

    def patched_write_text(
        self: Path,
        data: str,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> int:
        selected_encoding = encoding or "utf-8"
        selected_errors = errors
        selected_data = data
        if selected_encoding.lower().replace("_", "-") == "utf-8" and selected_errors is None:
            selected_errors = "backslashreplace"
            selected_data = safe_utf8_text(data)
        return _ORIGINAL_WRITE_TEXT(
            self,
            selected_data,
            encoding=selected_encoding,
            errors=selected_errors,
            newline=newline,
        )

    Path.write_text = patched_write_text  # type: ignore[method-assign]
    _PATCHED = True


__all__ = ["apply_safe_utf8_write_patch", "safe_utf8_text", "write_utf8_text"]
