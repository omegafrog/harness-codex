"""Validate the project ubiquitous language source of truth."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


REQUIRED_COLUMNS = (
    "Canonical Term",
    "Korean",
    "English",
    "Type",
    "Definition",
    "Aliases",
    "Forbidden Terms",
    "Source",
)

DEFAULT_SCAN_PATHS = (
    Path("docs/design"),
    Path("docs/use-cases"),
    Path("docs/plans"),
)


@dataclass(frozen=True)
class LanguageTerm:
    canonical_term: str
    korean: str
    english: str
    term_type: str
    definition: str
    aliases: tuple[str, ...]
    forbidden_terms: tuple[str, ...]
    source: str


class ContextLanguageError(ValueError):
    """Raised when context.md does not satisfy the language contract."""


def load_language_terms(context_path: Path) -> tuple[LanguageTerm, ...]:
    """Load the Ubiquitous Language table from context.md."""

    if not context_path.exists():
        raise ContextLanguageError(f"missing context file: {context_path}")

    text = context_path.read_text(encoding="utf-8")
    if "## 1. Ubiquitous Language" not in text and "## Ubiquitous Language" not in text:
        raise ContextLanguageError("context.md must contain a Ubiquitous Language section")

    rows = _markdown_table_rows(text)
    if len(rows) < 2:
        raise ContextLanguageError("context.md must contain a Ubiquitous Language markdown table")

    header = rows[0]
    missing = [column for column in REQUIRED_COLUMNS if column not in header]
    if missing:
        raise ContextLanguageError(
            "context.md Ubiquitous Language table is missing columns: "
            + ", ".join(missing)
        )

    header_index = {name: header.index(name) for name in REQUIRED_COLUMNS}
    terms: list[LanguageTerm] = []
    seen: set[str] = set()
    for row in rows[2:]:
        if len(row) < len(header):
            continue
        canonical = row[header_index["Canonical Term"]].strip()
        if not canonical or canonical in {"...", "-"}:
            continue
        normalized = canonical.casefold()
        if normalized in seen:
            raise ContextLanguageError(f"duplicate Canonical Term: {canonical}")
        seen.add(normalized)
        terms.append(
            LanguageTerm(
                canonical_term=canonical,
                korean=row[header_index["Korean"]].strip(),
                english=row[header_index["English"]].strip(),
                term_type=row[header_index["Type"]].strip(),
                definition=row[header_index["Definition"]].strip(),
                aliases=_split_terms(row[header_index["Aliases"]]),
                forbidden_terms=_split_terms(row[header_index["Forbidden Terms"]]),
                source=row[header_index["Source"]].strip(),
            )
        )

    if not terms:
        raise ContextLanguageError("context.md must define at least one Canonical Term")

    return tuple(terms)


def validate_forbidden_terms(
    repo_root: Path,
    terms: Iterable[LanguageTerm],
    scan_paths: Iterable[Path] = DEFAULT_SCAN_PATHS,
) -> tuple[str, ...]:
    """Return violations where a forbidden term appears in generated docs.

    Markdown headings, tables, and fenced code blocks are treated as document
    structure, not generated domain language. This prevents template headings
    such as ``## Exception Flow`` from failing a forbidden-term gate while still
    catching the same term in body prose.
    """

    forbidden = sorted(
        {
            forbidden
            for term in terms
            for forbidden in term.forbidden_terms
            if forbidden and forbidden not in {"-", "None", "없음"}
        },
        key=len,
        reverse=True,
    )
    if not forbidden:
        return ()

    violations: list[str] = []
    for relative in scan_paths:
        root = repo_root / relative
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.md")):
            text = _markdown_search_text(path.read_text(encoding="utf-8"))
            for forbidden_term in forbidden:
                if _contains_term(text, forbidden_term):
                    violations.append(f"{path.relative_to(repo_root)} contains forbidden term: {forbidden_term}")
    return tuple(violations)


def validate_context_language(repo_root: Path) -> tuple[str, ...]:
    terms = load_language_terms(repo_root / "context.md")
    return validate_forbidden_terms(repo_root, terms)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m harness_codex.context_language")
    parser.add_argument("--repo-root", default=".")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    try:
        violations = validate_context_language(repo_root)
    except ContextLanguageError as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2

    if violations:
        print("BLOCKED: forbidden Ubiquitous Language terms found", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 2

    print("OK: context.md Ubiquitous Language is valid")
    return 0


def _markdown_table_rows(text: str) -> list[list[str]]:
    rows: list[list[str]] = []
    in_language_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_language_section = stripped in {
                "## 1. Ubiquitous Language",
                "## Ubiquitous Language",
            }
            continue
        if not in_language_section:
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            rows.append([cell.strip() for cell in stripped.strip("|").split("|")])
        elif rows:
            break
    return rows


def _markdown_search_text(text: str) -> str:
    lines: list[str] = []
    in_code_block = False

    for line in text.splitlines():
        stripped = line.strip()

        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue

        if in_code_block:
            continue

        if stripped.startswith("#"):
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            continue

        lines.append(line)

    return "\n".join(lines)


def _split_terms(value: str) -> tuple[str, ...]:
    if not value or value.strip() in {"-", "None", "없음"}:
        return ()
    return tuple(term.strip() for term in re.split(r"[,/、，]", value) if term.strip())


def _contains_term(text: str, term: str) -> bool:
    if re.search(r"[A-Za-z0-9_]", term):
        return re.search(rf"(?<![A-Za-z0-9_]){re.escape(term)}(?![A-Za-z0-9_])", text, re.IGNORECASE) is not None
    return term in text


if __name__ == "__main__":
    raise SystemExit(main())
