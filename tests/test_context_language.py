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

CONTEXT_WITH_EXCEPTION_FORBIDDEN = """# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| 실패 흐름 | 실패 흐름 | FailureFlow | Other | 목표 달성이 실패하거나 거절되는 흐름 | Exception Flow | Exception | grill-me |

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


def test_validate_context_language_ignores_forbidden_terms_in_markdown_headings(
    tmp_path: Path,
) -> None:
    (tmp_path / "context.md").write_text(CONTEXT_WITH_EXCEPTION_FORBIDDEN, encoding="utf-8")
    use_case = tmp_path / "docs" / "use-cases" / "UC-001"
    use_case.mkdir(parents=True)
    (use_case / "use-case.md").write_text(
        """# UC-001. User performs goal

## Main Flow
1. The user performs the goal.

## Exception Flow
- None
""",
        encoding="utf-8",
    )

    assert validate_context_language(tmp_path) == ()


def test_validate_context_language_rejects_forbidden_terms_in_body_prose(
    tmp_path: Path,
) -> None:
    (tmp_path / "context.md").write_text(CONTEXT_WITH_EXCEPTION_FORBIDDEN, encoding="utf-8")
    use_case = tmp_path / "docs" / "use-cases" / "UC-001"
    use_case.mkdir(parents=True)
    (use_case / "use-case.md").write_text(
        """# UC-001. User performs goal

## Failure Flow
- The system handles the Exception.
""",
        encoding="utf-8",
    )

    assert validate_context_language(tmp_path) == (
        "docs/use-cases/UC-001/use-case.md contains forbidden term: Exception",
    )


def test_validate_context_language_ignores_forbidden_terms_in_code_blocks_and_tables(
    tmp_path: Path,
) -> None:
    (tmp_path / "context.md").write_text(CONTEXT_WITH_EXCEPTION_FORBIDDEN, encoding="utf-8")
    use_case = tmp_path / "docs" / "use-cases" / "UC-001"
    use_case.mkdir(parents=True)
    (use_case / "use-case.md").write_text(
        """# UC-001. User performs goal

| Section | Legacy Label |
|---|---|
| Flow | Exception |

```text
Exception
```

## Failure Flow
- None
""",
        encoding="utf-8",
    )

    assert validate_context_language(tmp_path) == ()
