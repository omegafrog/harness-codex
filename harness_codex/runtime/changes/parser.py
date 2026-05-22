"""Parse ChangeSet markdown into runtime models."""

from __future__ import annotations

import re
from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedMaintenanceItem,
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    ChangeSetDocument,
    GoalApproval,
    WorkItemType,
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
    metadata = _parse_table(_section(sections, "1. 메타데이터", "1. Metadata"))
    before_after = _parse_table(sections.get("3. Before / After", ""))

    change_set_id = _strip_code(metadata.get("ChangeSet ID", ""))
    if not change_set_id and path is not None:
        change_set_id = path.stem

    affected_use_cases = _parse_affected_use_cases(
        _section(
            sections,
            "5. 영향 유스케이스",
            "5. Affected Use Cases",
            "5. Affected use cases",
        )
    )
    affected_maintenance_items = _parse_affected_maintenance_items(
        _section(
            sections,
            "6. 영향 maintenance",
            "6. 영향 Maintenance",
            "6. 영향 유지보수",
            "5. 영향 maintenance",
            "6. Affected Maintenance",
            "6. Affected maintenance",
            "5. Affected Maintenance",
            "5. Affected maintenance",
        )
    )
    affected_work_items = _parse_affected_work_items(
        _section(
            sections,
            "5. 영향 Work Item",
            "5. 영향 work items",
            "5. 영향 작업",
            "6. 영향 작업",
            "6. Affected Work Items",
            "6. Affected work items",
            "5. Affected Work Items",
            "5. Affected work items",
        )
    )

    if not affected_work_items:
        affected_work_items = _legacy_work_items(
            affected_use_cases,
            affected_maintenance_items,
        )

    return ChangeSet(
        change_set_id=change_set_id,
        title=title,
        path=path,
        status=_first_value(metadata, "상태", "Status"),
        related_issue=_first_value(metadata, "관련 이슈/요청", "Related issue/request"),
        intent_summary=_bullet_value(
            _section(sections, "2. 구현 의도", "2. Implementation Intent"),
            "요청 요약",
            "Request summary",
        ),
        before_summary=before_after.get("Before", ""),
        after_summary=before_after.get("After", ""),
        changed_documents=_parse_changed_documents(
            _section(sections, "4. 변경 문서", "4. Changed Documents")
        ),
        affected_use_cases=affected_use_cases,
        affected_maintenance_items=affected_maintenance_items,
        affected_work_items=affected_work_items,
        goal_approvals=_parse_goal_approvals(
            _section(
                sections,
                "7. Verification Goal Changes",
                "7. Verification goal changes",
                "7. 검증 목표 변경",
                "7. 검증 목표 변경사항",
            )
        ),
        planner_inputs=_parse_bulleted_paths(
            _section(
                sections,
                "7. Planner 입력 범위",
                "7. Planner Input Scope",
                "8. Planner Input Scope",
            )
        ),
        included_scope=_parse_bullets_after_heading(
            _section(sections, "8. Scope Boundary", "9. Scope Boundary"),
            "### 포함",
            "### Included",
        ),
        excluded_scope=_parse_bullets_after_heading(
            _section(sections, "8. Scope Boundary", "9. Scope Boundary"),
            "### 제외",
            "### Excluded",
        ),
        forbidden_changes=_parse_bullets_after_heading(
            _section(sections, "8. Scope Boundary", "9. Scope Boundary"),
            "### 금지 변경",
            "### Forbidden Changes",
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


def _section(sections: dict[str, str], *names: str) -> str:
    for name in names:
        if name in sections:
            return sections[name]
    return ""


def _first_value(rows: dict[str, str], *names: str) -> str:
    for name in names:
        value = rows.get(name)
        if value:
            return value
    return ""


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
        if cells and cells[0] not in {
            "항목",
            "Item",
            "문서",
            "Document",
            "UC ID",
            "Use Case ID",
            "Maintenance ID",
            "MAINT ID",
            "Work Item ID",
            "작업 ID",
        }:
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


def _parse_affected_maintenance_items(
    section: str,
) -> tuple[AffectedMaintenanceItem, ...]:
    items: list[AffectedMaintenanceItem] = []

    for cells in _table_rows(section):
        if len(cells) >= 5:
            items.append(
                AffectedMaintenanceItem(
                    maintenance_id=_strip_code(cells[0]),
                    name=_strip_code(cells[1]),
                    impact_type=_strip_code(cells[2]),
                    slice_path=Path(_strip_code(cells[3])),
                    status=_strip_code(cells[4]),
                )
            )

    return tuple(items)


def _parse_affected_work_items(section: str) -> tuple[AffectedWorkItem, ...]:
    items: list[AffectedWorkItem] = []

    for cells in _table_rows(section):
        if len(cells) >= 6:
            items.append(
                AffectedWorkItem(
                    work_item_id=_strip_code(cells[0]),
                    work_item_type=WorkItemType(_strip_code(cells[1])),
                    name=_strip_code(cells[2]),
                    impact_type=_strip_code(cells[3]),
                    slice_path=Path(_strip_code(cells[4])),
                    status=_strip_code(cells[5]),
                )
            )

    return tuple(items)


def _parse_goal_approvals(section: str) -> tuple[GoalApproval, ...]:
    approvals: list[GoalApproval] = []

    for cells in _table_rows(section):
        if len(cells) >= 4:
            approvals.append(
                GoalApproval(
                    work_item_id=_strip_code(cells[0]),
                    path=Path(_strip_code(cells[1])),
                    change_status=_strip_code(cells[2]),
                    approval_status=_strip_code(cells[3]),
                    notes=_strip_code(cells[4]) if len(cells) >= 5 else "",
                )
            )

    return tuple(approvals)


def _legacy_work_items(
    use_cases: tuple[AffectedUseCase, ...],
    maintenance_items: tuple[AffectedMaintenanceItem, ...],
) -> tuple[AffectedWorkItem, ...]:
    return tuple(
        AffectedWorkItem(
            work_item_id=use_case.uc_id,
            work_item_type=WorkItemType.USE_CASE,
            name=use_case.name,
            impact_type=use_case.impact_type,
            slice_path=use_case.slice_path,
            status=use_case.status,
        )
        for use_case in use_cases
    ) + tuple(
        AffectedWorkItem(
            work_item_id=item.maintenance_id,
            work_item_type=WorkItemType.MAINTENANCE,
            name=item.name,
            impact_type=item.impact_type,
            slice_path=item.slice_path,
            status=item.status,
        )
        for item in maintenance_items
    )


def _parse_bulleted_paths(section: str) -> tuple[Path, ...]:
    paths: list[Path] = []

    for item in _parse_bullets(section):
        raw_path = item.split(" when ", maxsplit=1)[0].strip()
        if raw_path.startswith("`") and "`" in raw_path[1:]:
            paths.append(Path(_strip_code(raw_path)))

    return tuple(paths)


def _parse_bullets_after_heading(section: str, *headings: str) -> tuple[str, ...]:
    heading = next((candidate for candidate in headings if candidate in section), "")
    if not heading:
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


def _bullet_value(section: str, *labels: str) -> str:
    prefixes = tuple(f"- {label}:" for label in labels)
    for line in section.splitlines():
        stripped = line.strip()
        for prefix in prefixes:
            if stripped.startswith(prefix):
                return stripped.removeprefix(prefix).strip()
    return ""


def _strip_code(value: str) -> str:
    value = value.strip()
    if value.startswith("`") and value.endswith("`"):
        return value[1:-1]
    return value
