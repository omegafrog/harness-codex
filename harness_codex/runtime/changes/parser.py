"""Parse ChangeSet markdown into runtime models."""

from __future__ import annotations

import re
from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    ChangeSetDocument,
)


SECTION_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)


def parse_changeset_markdown(
    text: str,
    *,
    path: Path | None = None,
) -> ChangeSet:
    """Parse the repository ChangeSet template format."""

    title = _first_heading(text)
    sections = _sections(text)
    metadata = _parse_table(sections.get("1. 메타데이터", ""))
    before_after = _parse_table(sections.get("3. Before / After", ""))

    change_set_id = _strip_code(metadata.get("ChangeSet ID", ""))
    if not change_set_id and path is not None:
        change_set_id = path.stem

    return ChangeSet(
        change_set_id=change_set_id,
        title=title,
        path=path,
        status=metadata.get("상태", ""),
        related_issue=metadata.get("관련 이슈/요청", ""),
        intent_summary=_bullet_value(sections.get("2. 구현 의도", ""), "요청 요약"),
        before_summary=before_after.get("Before", ""),
        after_summary=before_after.get("After", ""),
        changed_documents=_parse_changed_documents(
            sections.get("4. 변경 문서", "")
        ),
        affected_use_cases=_parse_affected_use_cases(
            sections.get("5. 영향 유스케이스", "")
        ),
        planner_inputs=_parse_bulleted_paths(
            sections.get("7. Planner 입력 범위", "")
        ),
        included_scope=_parse_bullets_after_heading(
            sections.get("8. Scope Boundary", ""),
            "### 포함",
        ),
        excluded_scope=_parse_bullets_after_heading(
            sections.get("8. Scope Boundary", ""),
            "### 제외",
        ),
        forbidden_changes=_parse_bullets_after_heading(
            sections.get("8. Scope Boundary", ""),
            "### 금지 변경",
        ),
    )


def _first_heading(text: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _sections(text: str) -> dict[str, str]:
    matches = list(SECTION_RE.finditer(text))
    sections: dict[str, str] = {}

    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group("title").strip()] = text[start:end].strip()

    return sections


def _parse_table(section: str) -> dict[str, str]:
    rows: dict[str, str] = {}

    for cells in _table_rows(section):
        if len(cells) >= 2:
            rows[_strip_code(cells[0])] = _strip_code(cells[1])

    return rows


def _table_rows(section: str) -> list[list[str]]:
    rows: list[list[str]] = []

    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped:
            continue

        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if cells and cells[0] not in {"항목", "문서", "UC ID"}:
            rows.append(cells)

    return rows


def _parse_changed_documents(section: str) -> tuple[ChangeSetDocument, ...]:
    documents: list[ChangeSetDocument] = []

    for cells in _table_rows(section):
        if len(cells) >= 4:
            documents.append(
                ChangeSetDocument(
                    path=Path(_strip_code(cells[0])),
                    change_type=_strip_code(cells[1]),
                    reason=_strip_code(cells[2]),
                    status=_strip_code(cells[3]),
                )
            )

    return tuple(documents)


def _parse_affected_use_cases(section: str) -> tuple[AffectedUseCase, ...]:
    use_cases: list[AffectedUseCase] = []

    for cells in _table_rows(section):
        if len(cells) >= 5:
            use_cases.append(
                AffectedUseCase(
                    uc_id=_strip_code(cells[0]),
                    name=_strip_code(cells[1]),
                    impact_type=_strip_code(cells[2]),
                    slice_path=Path(_strip_code(cells[3])),
                    status=_strip_code(cells[4]),
                )
            )

    return tuple(use_cases)


def _parse_bulleted_paths(section: str) -> tuple[Path, ...]:
    paths: list[Path] = []

    for item in _parse_bullets(section):
        raw_path = item.split(" when ", maxsplit=1)[0].strip()
        if raw_path.startswith("`") and "`" in raw_path[1:]:
            paths.append(Path(_strip_code(raw_path)))

    return tuple(paths)


def _parse_bullets_after_heading(section: str, heading: str) -> tuple[str, ...]:
    if heading not in section:
        return ()

    after_heading = section.split(heading, maxsplit=1)[1]
    next_heading = after_heading.find("### ")
    if next_heading != -1:
        after_heading = after_heading[:next_heading]

    return tuple(_parse_bullets(after_heading))


def _parse_bullets(section: str) -> list[str]:
    return [
        line.removeprefix("-").strip()
        for line in section.splitlines()
        if line.strip().startswith("-") and line.removeprefix("-").strip()
    ]


def _bullet_value(section: str, label: str) -> str:
    prefix = f"- {label}:"
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped.removeprefix(prefix).strip()
    return ""


def _strip_code(value: str) -> str:
    value = value.strip()
    if value.startswith("`") and value.endswith("`"):
        return value[1:-1]
    return value
