import json
from pathlib import Path

from harness_codex.runtime.interactive_harvest import (
    _json_dumps_utf8_safe,
    _utf8_safe_text,
    _write_initial_named_session,
)


def test_utf8_safe_text_replaces_lone_surrogates():
    text = "draft note \udcff answer"

    safe = _utf8_safe_text(text)

    assert "\udcff" not in safe
    safe.encode("utf-8")


def test_json_dumps_utf8_safe_replaces_nested_lone_surrogates():
    payload = {"answer": "Zeten Castell note \udcff draft"}

    dumped = _json_dumps_utf8_safe(payload)

    assert "\udcff" not in dumped
    dumped.encode("utf-8")
    assert json.loads(dumped)["answer"] == "Zeten Castell note ? draft"


def test_write_initial_named_session_accepts_invalid_unicode(tmp_path: Path):
    _write_initial_named_session(
        tmp_path,
        "unicode-session",
        "개인 엔드유저가 노트 초안 작성 \udcff",
    )

    session_path = tmp_path / ".harness/ui/sessions/unicode-session.json"
    assert session_path.is_file()
    text = session_path.read_text(encoding="utf-8")
    assert "\udcff" not in text
    assert "개인 엔드유저가 노트 초안 작성" in text
