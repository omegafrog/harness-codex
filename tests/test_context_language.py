from pathlib import Path

import pytest

from harness_codex.context_language import (
    ContextLanguageError,
    load_language_terms,
    validate_context_language,
)


VALID_CONTEXT = """# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| 대기열 | 대기열 | WaitingQueue | Domain Concept | 사용자가 진입 순서를 기다리는 도메인 개념 | queue, waitlist | 줄, 웨이팅 리스트 | grill-me |

## 2. Naming Rules

- Documents must use `Canonical Term`.
"""


def test_load_language_terms_reads_required_table(tmp_path: Path) -> None:
    context = tmp_path / "context.md"
    context.write_text(VALID_CONTEXT, encoding="utf-8")

    terms = load_language_terms(context)

    assert len(terms) == 1
    assert terms[0].canonical_term == "대기열"
    assert terms[0].english == "WaitingQueue"
    assert terms[0].aliases == ("queue", "waitlist")
    assert terms[0].forbidden_terms == ("줄", "웨이팅 리스트")


def test_load_language_terms_rejects_duplicate_canonical_terms(tmp_path: Path) -> None:
    context = tmp_path / "context.md"
    context.write_text(
        VALID_CONTEXT.replace(
            "| 대기열 | 대기열 | WaitingQueue | Domain Concept | 사용자가 진입 순서를 기다리는 도메인 개념 | queue, waitlist | 줄, 웨이팅 리스트 | grill-me |",
            "| 대기열 | 대기열 | WaitingQueue | Domain Concept | 사용자가 진입 순서를 기다리는 도메인 개념 | queue, waitlist | 줄, 웨이팅 리스트 | grill-me |\n"
            "| 대기열 | 대기열 | WaitingQueue | Domain Concept | 중복 정의 | - | - | grill-me |",
        ),
        encoding="utf-8",
    )

    with pytest.raises(ContextLanguageError, match="duplicate Canonical Term"):
        load_language_terms(context)


def test_validate_context_language_rejects_forbidden_terms_in_docs(tmp_path: Path) -> None:
    (tmp_path / "context.md").write_text(VALID_CONTEXT, encoding="utf-8")
    docs = tmp_path / "docs" / "design"
    docs.mkdir(parents=True)
    (docs / "요구사항.md").write_text("사용자는 웨이팅 리스트에 들어간다.", encoding="utf-8")

    violations = validate_context_language(tmp_path)

    assert violations == ("docs/design/요구사항.md contains forbidden term: 웨이팅 리스트",)


def test_validate_context_language_allows_clean_docs(tmp_path: Path) -> None:
    (tmp_path / "context.md").write_text(VALID_CONTEXT, encoding="utf-8")
    docs = tmp_path / "docs" / "design"
    docs.mkdir(parents=True)
    (docs / "요구사항.md").write_text("사용자는 대기열에 들어간다.", encoding="utf-8")

    assert validate_context_language(tmp_path) == ()
