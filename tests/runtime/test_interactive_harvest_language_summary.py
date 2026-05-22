from pathlib import Path

from harness_codex.runtime.interactive_harvest import (
    _format_ubiquitous_language_summary,
    _parse_ubiquitous_language_rows,
)


def test_parse_ubiquitous_language_rows_from_context_markdown():
    markdown = """# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| Zettel Note | 제텔 노트 | Zettel Note | Entity | Atomic note. | Note | memo, page | grill-me |
| Rewrite Suggestion | 재작성 제안 | Rewrite Suggestion | Concept | Agent proposal. | - | rewrite result<br>fixed note | grill-me |

## 2. Naming Rules
"""

    rows = _parse_ubiquitous_language_rows(markdown)

    assert rows == [
        {
            "canonical term": "Zettel Note",
            "korean": "제텔 노트",
            "english": "Zettel Note",
            "type": "Entity",
            "definition": "Atomic note.",
            "aliases": "Note",
            "forbidden terms": "memo, page",
            "source": "grill-me",
        },
        {
            "canonical term": "Rewrite Suggestion",
            "korean": "재작성 제안",
            "english": "Rewrite Suggestion",
            "type": "Concept",
            "definition": "Agent proposal.",
            "aliases": "-",
            "forbidden terms": "rewrite result<br>fixed note",
            "source": "grill-me",
        },
    ]


def test_format_ubiquitous_language_summary_lists_confirmed_and_forbidden_terms(tmp_path: Path):
    (tmp_path / "context.md").write_text(
        """# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| Zettel Note | 제텔 노트 | Zettel Note | Entity | Atomic note. | Note | memo, page | grill-me |
| Rewrite Suggestion | 재작성 제안 | Rewrite Suggestion | Concept | Agent proposal. | - | rewrite result<br>fixed note | grill-me |

## 2. Naming Rules
""",
        encoding="utf-8",
    )

    summary = _format_ubiquitous_language_summary(tmp_path)

    assert "Confirmed Ubiquitous Language:" in summary
    assert "- Zettel Note (제텔 노트 / Zettel Note)" in summary
    assert "- Rewrite Suggestion (재작성 제안 / Rewrite Suggestion)" in summary
    assert "Forbidden Language:" in summary
    assert "- memo -> Zettel Note" in summary
    assert "- page -> Zettel Note" in summary
    assert "- rewrite result -> Rewrite Suggestion" in summary
    assert "- fixed note -> Rewrite Suggestion" in summary


def test_format_ubiquitous_language_summary_prints_none_when_no_forbidden_terms(tmp_path: Path):
    (tmp_path / "context.md").write_text(
        """# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |

## 2. Naming Rules
""",
        encoding="utf-8",
    )

    summary = _format_ubiquitous_language_summary(tmp_path)

    assert "- User (사용자 / User)" in summary
    assert "Forbidden Language:\n- none" in summary
