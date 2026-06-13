"""Create ChangeSet execution inputs from harvested design documents."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.document_metadata import (
    apply_front_matter,
    infer_document_metadata,
    parse_front_matter,
    write_contract_sidecar,
)


USE_CASE_RE = re.compile(
    r"^(?:##\s+|-\s+)?(?P<id>UC[- ]?\d+)\.?\s*(?P<name>.+?)\s*$",
    re.MULTILINE,
)
SECTION_RE = re.compile(r"^##\s+.+?\s*$", re.MULTILINE)
SLICE_HEADING_RE = re.compile(r"^#\s+(?P<title>.+?)\s*$", re.MULTILINE)


class DesignBridgeError(RuntimeError):
    """Raised when harvested design documents cannot become execution inputs."""


@dataclass(frozen=True)
class DesignUseCase:
    uc_id: str
    source_id: str
    name: str
    source_block: str

    @property
    def slice_path(self) -> Path:
        return Path("docs/use-cases") / self.uc_id


@dataclass(frozen=True)
class DesignBridgeResult:
    change_set_id: str
    change_set_path: Path
    use_cases: tuple[DesignUseCase, ...]
    created_paths: tuple[Path, ...]


def create_changeset_from_design(
    repo_root: Path | str,
    *,
    title: str,
    change_set_id: str | None = None,
    related_issue: str = "",
    selected_use_cases: tuple[str, ...] = (),
    force: bool = False,
) -> DesignBridgeResult:
    repo = Path(repo_root)
    requirements_path = Path("docs/design/요구사항.md")
    use_cases_path = Path("docs/design/유스케이스.md")
    requirements = _read_required(repo, requirements_path)
    use_cases_text = _read_required(repo, use_cases_path)
    use_cases = _parse_design_use_cases(use_cases_text)
    if not use_cases:
        use_cases = _parse_use_case_slices(repo)

    if selected_use_cases:
        selected = {_normalize_uc_id(uc_id) for uc_id in selected_use_cases}
        use_cases = tuple(uc for uc in use_cases if uc.uc_id in selected)

    if not use_cases:
        raise DesignBridgeError(
            "No use cases found. Checked docs/design/유스케이스.md and "
            "docs/use-cases/UC-*/use-case.md. Expected '- UC-001. ...' "
            "or generated runtime slice docs."
        )

    if change_set_id is None:
        change_set_id = _next_change_set_id(repo)

    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    documents: dict[Path, str] = {}
    overwrite_allowed: set[Path] = set()
    documents[change_set_path] = _with_metadata(
        change_set_path,
        _render_change_set(
            change_set_id=change_set_id,
            title=title,
            related_issue=related_issue,
            requirements_path=requirements_path,
            use_cases_path=use_cases_path,
            requirements=requirements,
            use_cases=use_cases,
        ),
        change_set_id=change_set_id,
        source_docs=(requirements_path, use_cases_path),
        status="active",
    )
    created_paths = [change_set_path]

    for use_case in use_cases:
        for path, text in _render_use_case_slice(
            change_set_id=change_set_id,
            use_case=use_case,
        ).items():
            if force or not (repo / path).exists():
                documents[path] = text
                created_paths.append(path)
                continue
            if path.name == "e2e-goal.md":
                current = (repo / path).read_text(encoding="utf-8")
                approved = _ensure_e2e_goal_approved(current)
                approved = _with_metadata(
                    path,
                    approved,
                    change_set_id=change_set_id,
                    work_item_id=use_case.uc_id,
                    source_docs=(change_set_path, use_case.slice_path / "use-case.md"),
                    approval_status="approved",
                    status="approved",
                )
                if approved != current:
                    documents[path] = approved
                    overwrite_allowed.add(path)
                    created_paths.append(path)
            elif path.name == "index.md":
                current = (repo / path).read_text(encoding="utf-8")
                approved = current.replace(
                    "|`e2e-goal.md`|Given/When/Then verification target|pending approval|",
                    "|`e2e-goal.md`|Given/When/Then verification target|approved|",
                )
                approved = _with_metadata(
                    path,
                    approved,
                    change_set_id=change_set_id,
                    work_item_id=use_case.uc_id,
                    source_docs=(change_set_path,),
                    status="draft",
                )
                if approved != current:
                    documents[path] = approved
                    overwrite_allowed.add(path)
                    created_paths.append(path)

    _write_documents(repo, documents, force=force, overwrite_allowed=overwrite_allowed)
    _write_contracts(repo, documents)
    return DesignBridgeResult(
        change_set_id=change_set_id,
        change_set_path=change_set_path,
        use_cases=use_cases,
        created_paths=tuple(dict.fromkeys(created_paths)),
    )


def sync_changeset_use_cases_from_design(
    repo_root: Path | str,
    *,
    change_set_id: str,
) -> DesignBridgeResult:
    repo = Path(repo_root)
    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    absolute_path = repo / change_set_path
    if not absolute_path.exists():
        raise DesignBridgeError(f"Active ChangeSet not found: {change_set_path}")

    use_cases_text = _read_required(repo, Path("docs/design/유스케이스.md"))
    use_cases = _parse_design_use_cases(use_cases_text) or _parse_use_case_slices(repo)
    if not use_cases:
        raise DesignBridgeError(
            "No use cases found. Checked docs/design/유스케이스.md and "
            "docs/use-cases/UC-*/use-case.md."
        )

    current_text = absolute_path.read_text(encoding="utf-8")
    current = parse_changeset_markdown(current_text, path=change_set_path)
    current_use_cases = {item.uc_id: item for item in current.affected_use_cases}
    maintenance_items = tuple(
        item
        for item in current.ordered_work_items()
        if item.work_item_type is WorkItemType.MAINTENANCE
    )
    synchronized_use_case_ids = {use_case.uc_id for use_case in use_cases}
    maintenance_goals = tuple(
        goal
        for goal in current.goal_approvals
        if goal.work_item_id not in synchronized_use_case_ids
    )

    affected_rows: list[str] = []
    work_item_rows: list[str] = []
    for use_case in use_cases:
        existing = current_use_cases.get(use_case.uc_id)
        impact_type = existing.impact_type if existing else "new"
        status = existing.status if existing else "planned"
        affected_rows.append(
            f"|`{use_case.uc_id}`|{_escape_table(use_case.name)}|"
            f"{_escape_table(impact_type)}|"
            f"`{use_case.slice_path}/`|"
            f"{_escape_table(status)}|"
        )
        work_item_rows.append(
            f"|`{use_case.uc_id}`|use_case|{_escape_table(use_case.name)}|"
            f"{_escape_table(impact_type)}|"
            f"`{use_case.slice_path}/`|"
            f"{_escape_table(status)}|"
        )
    work_item_rows.extend(
        (
            f"|`{item.work_item_id}`|maintenance|{_escape_table(item.name)}|"
            f"{_escape_table(item.impact_type)}|`{item.slice_path}/`|"
            f"{_escape_table(item.status)}|"
        )
        for item in maintenance_items
    )
    goal_rows = [
        (
            f"|`{use_case.uc_id}`|`{use_case.slice_path}/e2e-goal.md`|"
            "updated|approved|Synchronized after use-case definition|"
        )
        for use_case in use_cases
    ]
    goal_rows.extend(
        (
            f"|`{goal.work_item_id}`|`{goal.path}`|{_escape_table(goal.change_status)}|"
            f"{_escape_table(goal.approval_status)}|{_escape_table(goal.notes)}|"
        )
        for goal in maintenance_goals
    )

    updated = _upsert_numbered_section(
        current_text,
        number=5,
        titles=("Affected Use Cases", "Affected use cases", "영향 유스케이스"),
        content=(
            "## 5. Affected Use Cases\n\n"
            "|Use Case ID|Use Case Name|Impact Type|Slice Path|Status|\n"
            "|---|---|---|---|---|\n"
            + "\n".join(affected_rows)
            + "\n"
        ),
    )
    updated = _upsert_numbered_section(
        updated,
        number=6,
        titles=("Affected Work Items", "Affected work items", "영향 Work Item", "영향 작업"),
        content=(
            "## 6. Affected Work Items\n\n"
            "|Work Item ID|Type|Name|Impact Type|Slice Path|Status|\n"
            "|---|---|---|---|---|---|\n"
            + "\n".join(work_item_rows)
            + "\n"
        ),
    )
    updated = _upsert_numbered_section(
        updated,
        number=7,
        titles=(
            "Verification Goal Changes",
            "Verification goal changes",
            "검증 목표 변경",
            "검증 목표 변경사항",
        ),
        content=(
            "## 7. Verification Goal Changes\n\n"
            "|Work Item ID|Verification Goal Path|Change Status|Approval Status|Notes|\n"
            "|---|---|---|---|---|\n"
            + "\n".join(goal_rows)
            + "\n"
        ),
    )
    absolute_path.write_text(updated, encoding="utf-8")
    return DesignBridgeResult(
        change_set_id=change_set_id,
        change_set_path=change_set_path,
        use_cases=use_cases,
        created_paths=(change_set_path,),
    )


def _upsert_numbered_section(
    text: str,
    *,
    number: int,
    titles: tuple[str, ...],
    content: str,
) -> str:
    headings = list(
        re.finditer(
            r"(?m)^##\s+(?P<number>\d+)\.\s+(?P<title>.+?)\s*$",
            text,
        )
    )
    for index, heading in enumerate(headings):
        if heading.group("title") not in titles:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        return (
            text[: heading.start()].rstrip()
            + "\n\n"
            + content.rstrip()
            + "\n\n"
            + text[end:].lstrip()
        )

    insert_at = len(text)
    for heading in headings:
        if int(heading.group("number")) > number:
            insert_at = heading.start()
            break
    return (
        text[:insert_at].rstrip()
        + "\n\n"
        + content.rstrip()
        + "\n\n"
        + text[insert_at:].lstrip()
    )


def _read_required(repo: Path, relative_path: Path) -> str:
    path = repo / relative_path
    if not path.exists():
        raise DesignBridgeError(f"Required design document not found: {relative_path}")
    return path.read_text(encoding="utf-8")


def _parse_design_use_cases(text: str) -> tuple[DesignUseCase, ...]:
    sections = list(SECTION_RE.finditer(text))
    by_id: dict[str, DesignUseCase] = {}

    for match in USE_CASE_RE.finditer(text):
        raw_id = match.group("id")
        uc_id = _normalize_uc_id(raw_id)
        if uc_id in by_id and not match.group(0).startswith("##"):
            continue
        name = match.group("name").strip()
        block = _source_block(text, match.start(), sections)
        by_id[uc_id] = DesignUseCase(
            uc_id=uc_id,
            source_id=raw_id,
            name=name,
            source_block=block,
        )

    return tuple(by_id.values())


def _parse_use_case_slices(repo: Path) -> tuple[DesignUseCase, ...]:
    slice_root = repo / "docs/use-cases"
    if not slice_root.exists():
        return ()

    use_cases: list[DesignUseCase] = []
    for directory in sorted(slice_root.glob("UC-*")):
        if not directory.is_dir():
            continue
        use_case_path = directory / "use-case.md"
        if not use_case_path.exists():
            continue
        text = use_case_path.read_text(encoding="utf-8")
        uc_id = _normalize_uc_id(directory.name)
        use_cases.append(
            DesignUseCase(
                uc_id=uc_id,
                source_id=directory.name,
                name=_slice_use_case_name(text, uc_id),
                source_block=text.strip(),
            )
        )
    return tuple(use_cases)


def _slice_use_case_name(text: str, uc_id: str) -> str:
    match = SLICE_HEADING_RE.search(text)
    if match is None:
        return uc_id
    title = match.group("title").strip()
    title = re.sub(rf"^{re.escape(uc_id)}\.?\s*", "", title, flags=re.IGNORECASE).strip()
    return title or uc_id


def _source_block(text: str, start: int, sections: list[re.Match[str]]) -> str:
    end = len(text)
    for section in sections:
        if section.start() > start:
            end = section.start()
            break
    return text[start:end].strip()


def _normalize_uc_id(raw_id: str) -> str:
    match = re.search(r"\d+", raw_id)
    if match is None:
        raise DesignBridgeError(f"Invalid use-case id: {raw_id}")
    number = int(match.group(0))
    return f"UC-{number:03d}"


def _ensure_e2e_goal_approved(text: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("|Approval Status|"):
            lines[index] = "|Approval Status|approved|"
            if not any(item.strip().startswith("|Approved by|") for item in lines):
                lines.insert(index + 1, "|Approved by|user-confirmed harvest/design intake|")
            return "\n".join(lines) + ("\n" if text.endswith("\n") else "")

    if not lines:
        return text

    insert_at = 1 if lines[0].startswith("# ") else 0
    metadata = [
        "",
        "## Metadata",
        "|Item|Value|",
        "|---|---|",
        "|Approval Status|approved|",
        "|Approved by|user-confirmed harvest/design intake|",
    ]
    return "\n".join(lines[:insert_at] + metadata + lines[insert_at:]) + "\n"


def _next_change_set_id(repo: Path) -> str:
    date = datetime.now().strftime("%Y%m%d")
    active = repo / "docs/changes/active"
    completed = repo / "docs/changes/completed"
    existing = [
        path.stem
        for directory in (active, completed)
        for path in directory.glob(f"CHG-{date}-*.md")
        if directory.exists()
    ]
    sequence = 1
    for value in existing:
        try:
            sequence = max(sequence, int(value.rsplit("-", maxsplit=1)[1]) + 1)
        except (IndexError, ValueError):
            continue
    return f"CHG-{date}-{sequence:03d}"


def _render_change_set(
    *,
    change_set_id: str,
    title: str,
    related_issue: str,
    requirements_path: Path,
    use_cases_path: Path,
    requirements: str,
    use_cases: tuple[DesignUseCase, ...],
) -> str:
    changed_rows = "\n".join(
        [
            f"|`{requirements_path}`|read|Canonical requirements source|ready|",
            f"|`{use_cases_path}`|read|Canonical use-case source|ready|",
            *[
                f"|`{use_case.slice_path}/`|create|Execution slice for {use_case.uc_id}|planned|"
                for use_case in use_cases
            ],
        ]
    )
    affected_rows = "\n".join(
        f"|`{use_case.uc_id}`|{_escape_table(use_case.name)}|new|`{use_case.slice_path}/`|planned|"
        for use_case in use_cases
    )
    work_item_rows = "\n".join(
        f"|`{use_case.uc_id}`|use_case|{_escape_table(use_case.name)}|new|`{use_case.slice_path}/`|planned|"
        for use_case in use_cases
    )
    goal_rows = "\n".join(
        f"|`{use_case.uc_id}`|`{use_case.slice_path}/e2e-goal.md`|new|approved|Generated from confirmed design intake|"
        for use_case in use_cases
    )
    summary = _first_non_empty_line(requirements) or title

    return f"""# {_escape_text(title)}

## 1. Metadata

|Item|Value|
|---|---|
|ChangeSet ID|`{change_set_id}`|
|Status|active|
|Created date|{datetime.now().strftime("%Y-%m-%d")}|
|Author|Codex|
|Related issue/request|{_escape_table(related_issue) or "-"}|

## 2. Implementation Intent

- Request summary: {_escape_text(title)}
- Expected user result: The harvested design docs become runnable ChangeSet workflow inputs.
- Reason for change: The runtime pipeline starts from ChangeSet and use-case slice docs, but harvested design docs are upstream canonical inputs.

## 3. Before / After

|Item|Content|
|---|---|
|Before|{_escape_table(summary)}|
|After|An active ChangeSet and affected use-case slices exist for runtime planning.|

## 4. Changed Documents

|Document|Change Type|Reason|Status|
|---|---|---|---|
{changed_rows}

## 5. Affected Use Cases

|Use Case ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
{affected_rows}

## 6. Affected Work Items

|Work Item ID|Type|Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|---|
{work_item_rows}

## 7. Verification Goal Changes

|Work Item ID|Verification Goal Path|Change Status|Approval Status|Notes|
|---|---|---|---|---|
{goal_rows}

## 8. Planner Input Scope

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md` when present
- `docs/use-cases/<UC-ID>/technical-decisions.md` when present
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `docs/use-cases/<UC-ID>/affected-files.md`
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`

## 9. Scope Boundary

### Included

- Create runtime execution inputs from `{requirements_path}` and `{use_cases_path}`.
- Plan and implement only the affected use-case slices listed in this ChangeSet.

### Excluded

- Redesigning canonical requirements or canonical use cases during execution.
- Creating maintenance work items unless a later ChangeSet explicitly adds them.

### Forbidden Changes

- Do not edit use-case slice docs outside this ChangeSet.
- Do not edit `docs/design/**` unless a ChangeSet explicitly approves canonical design changes.
- Do not make unlisted code, test, or configuration changes.

## 10. Completion Conditions

- Every affected use-case slice exists.
- Every affected use-case E2E goal is approved before implementation planning.
- Every affected use-case plan completes and moves to `docs/plans/completed/<UC-ID>/plan.md`.
- Required repository test gates pass.
- This ChangeSet moves to `docs/changes/completed/{change_set_id}.md`.

## 11. Verification Record

|Command/Check|Result|Evidence|
|---|---|---|
|`python3 -m harness_codex changes list`|pending||
|`python3 -m harness_codex use-case-definition {change_set_id}`|pending||

## 12. Blockers / Conflicts

- None.
"""


def _render_use_case_slice(
    *,
    change_set_id: str,
    use_case: DesignUseCase,
) -> dict[Path, str]:
    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    use_case_path = use_case.slice_path / "use-case.md"
    e2e_path = use_case.slice_path / "e2e-goal.md"
    return {
        use_case.slice_path / "index.md": _with_metadata(
            use_case.slice_path / "index.md",
            _render_index(change_set_path, use_case),
            change_set_id=change_set_id,
            work_item_id=use_case.uc_id,
            source_docs=(change_set_path,),
            status="draft",
        ),
        use_case_path: _with_metadata(
            use_case_path,
            _render_use_case(change_set_path, use_case),
            change_set_id=change_set_id,
            work_item_id=use_case.uc_id,
            source_docs=(change_set_path, Path("docs/design/유스케이스.md")),
            status="draft",
        ),
        use_case.slice_path / "event-storming.md": _with_metadata(
            use_case.slice_path / "event-storming.md",
            _render_event_storming(
                change_set_path,
                use_case,
            ),
            change_set_id=change_set_id,
            work_item_id=use_case.uc_id,
            source_docs=(change_set_path, use_case_path, e2e_path),
            status="pending",
        ),
        e2e_path: _with_metadata(
            e2e_path,
            _render_e2e_goal(change_set_path, use_case),
            change_set_id=change_set_id,
            work_item_id=use_case.uc_id,
            source_docs=(change_set_path, use_case_path),
            approval_status="approved",
            status="approved",
        ),
        use_case.slice_path / "affected-files.md": _with_metadata(
            use_case.slice_path / "affected-files.md",
            _render_affected_files(
                change_set_path,
                use_case,
            ),
            change_set_id=change_set_id,
            work_item_id=use_case.uc_id,
            source_docs=(change_set_path, use_case_path),
            status="draft",
        ),
    }


def _render_index(change_set_path: Path, use_case: DesignUseCase) -> str:
    return f"""# {use_case.uc_id}. {_escape_text(use_case.name)}

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`{use_case.uc_id}`|
|Status|draft|
|Related ChangeSet|`{change_set_path}`|
|Canonical source|`docs/design/유스케이스.md`|

## 2. Slice Documents

|Document|Purpose|Status|
|---|---|---|
|`use-case.md`|Use-case execution scope|draft|
|`event-storming.md`|Event-storming route and generated storming output|draft|
|`e2e-goal.md`|Business acceptance contract and observable success/failure criteria|approved|
|`affected-files.md`|Expected files and forbidden paths|draft|

## 3. Runtime Paths

- Active plan: `docs/plans/active/{use_case.uc_id}/plan.md`
- Verification: `docs/plans/active/{use_case.uc_id}/verification.md`
- Completed plan: `docs/plans/completed/{use_case.uc_id}/plan.md`
"""


def _render_use_case(change_set_path: Path, use_case: DesignUseCase) -> str:
    source = _escape_fence(use_case.source_block)
    return f"""# {use_case.uc_id}. {_escape_text(use_case.name)}

## 1. Overview

- Actor: See canonical source.
- Supporting actor: See canonical source.
- Goal: {_escape_text(use_case.name)}
- Related ChangeSet: `{change_set_path}`
- Canonical source: `docs/design/유스케이스.md`

## 2. Preconditions

- See canonical source.

## 3. Basic Flow

1. Follow the canonical use-case flow for `{use_case.source_id}`.

## 4. Exception Flow

|Condition|System Response|User / External Observation|
|---|---|---|
|Invalid or unsupported input|Reject the operation and keep the user in a recoverable state.|The user sees an actionable failure result.|

## 5. Outcomes

### Success Outcomes

- The user achieves the goal described by `{use_case.source_id}`.

### Failure Outcomes

- Invalid, unsupported, or incomplete input is rejected without corrupting state.

## 6. Non-Functional Requirements

|Area|Requirement|Decision Status|
|---|---|---|
|Performance|Use the canonical non-functional requirements when present.|ready|
|Consistency|Keep operation results deterministic for the same input.|ready|
|Security / Authorization|Use the canonical security requirements when present.|ready|
|Operations|Expose failures clearly enough for verification.|ready|

## 7. Scope

### Included

- Implement behavior needed for `{use_case.source_id}`.

### Excluded

- Behavior from use cases not listed in the active ChangeSet.

## 8. Canonical Excerpt

```markdown
{source}
```

## 9. Confirmation Needed

- Approve the E2E goal before implementation planning.
"""


def _render_event_storming(change_set_path: Path, use_case: DesignUseCase) -> str:
    return f"""# {use_case.uc_id}. {_escape_text(use_case.name)} Event Storming

## 1. Inputs

- ChangeSet: `{change_set_path}`
- Use case: `docs/use-cases/{use_case.uc_id}/use-case.md`
- E2E goal: `docs/use-cases/{use_case.uc_id}/e2e-goal.md`
- Canonical source: `docs/design/유스케이스.md`

## 2. Status

- Event storming has not been derived yet.
- Run the event-storming step for this affected use-case slice before DDD design.

## 3. Draft Elements

|Type|Name|Source|Status|
|---|---|---|---|
|Command|To be derived|`{use_case.source_id}`|pending|
|Event|To be derived|`{use_case.source_id}`|pending|
|Policy|To be derived|`{use_case.source_id}`|pending|

## 4. Scope Boundary

### Included

- Derive commands, events, policies, external systems, and invariants for `{use_case.source_id}` only.

### Excluded

- Event-storming content for unaffected use cases.
"""


def _render_e2e_goal(change_set_path: Path, use_case: DesignUseCase) -> str:
    return f"""# {use_case.uc_id}. {_escape_text(use_case.name)} E2E Goal

## 1. Metadata

|Item|Value|
|---|---|
|UC ID|`{use_case.uc_id}`|
|Related ChangeSet|`{change_set_path}`|
|Approval Status|approved|
|Approved by|user-confirmed harvest/design intake|

## 2. Business Goal

- User-observable result: The user completes `{use_case.source_id}` successfully.
- System completion condition: The implementation satisfies the canonical use-case flow and rejects invalid input safely.

## 3. Given / When / Then

### Given

- The application is available to the user.
- Inputs required by `{use_case.source_id}` are available.

### When

- The user performs `{use_case.source_id}`.

### Then

- The system returns the expected successful result.
- Invalid or unsupported input returns an actionable failure result.

## 4. Business Success Criteria

- The use-case happy path passes through the user-visible interface.
- Invalid input handling is covered by tests.

## 5. Business Failure Criteria

- The implementation produces an incorrect result for valid input.
- The implementation accepts invalid input silently.

## 6. Observability Boundary

- Browser-visible UI: needs confirmation
- API/runtime observable behavior: needs confirmation
- Required user-visible evidence: The actor can observe the successful result and actionable failure result.

## 7. Out of Scope

- Implementation-specific commands, fixtures, API request/response examples, UI automation steps, and actual pass/fail output.
- These details belong in `docs/plans/active/{use_case.uc_id}/verification.md` or the plan verification result after implementation.

## 8. Confirmation Needed

- None
"""


def _render_affected_files(change_set_path: Path, use_case: DesignUseCase) -> str:
    return f"""# {use_case.uc_id}. {_escape_text(use_case.name)} Affected Files

## 1. Inputs

- ChangeSet: `{change_set_path}`
- Use case: `docs/use-cases/{use_case.uc_id}/use-case.md`
- E2E goal: `docs/use-cases/{use_case.uc_id}/e2e-goal.md`

## 2. Expected Changed Files

|Path|Change Type|Reason|Verification Method|
|---|---|---|---|
|Application source paths|create/update|Implement `{use_case.source_id}`|Repository test gate|

## 3. Expected Test Files

|Path|Test Target|Verification Rule|
|---|---|---|
|Application test paths|`{use_case.source_id}` behavior|Happy path and invalid input behavior pass|

## 4. Documentation Files

|Path|Reason|Approval Required|
|---|---|---|
|`docs/use-cases/{use_case.uc_id}/...`|Use-case execution slice|yes|

## 5. Forbidden Files / Paths

|Path|Reason|
|---|---|
|`docs/use-cases/<other-UC-ID>/`|Outside the active ChangeSet scope|
|`docs/design/**`|Canonical changes require explicit ChangeSet approval|

## 6. Scope Boundary

### Included

- Files needed to implement and verify `{use_case.source_id}`.

### Excluded

- Unaffected use-case docs and unrelated application behavior.

## 7. Confirmation Needed

- Replace broad application source and test path placeholders during implementation planning.
"""


def _write_documents(
    repo: Path,
    documents: dict[Path, str],
    *,
    force: bool,
    overwrite_allowed: set[Path] | None = None,
) -> None:
    overwrite_allowed = overwrite_allowed or set()
    conflicts = tuple(
        path
        for path in documents
        if (repo / path).exists() and path not in overwrite_allowed
    )
    if conflicts and not force:
        joined = ", ".join(str(path) for path in conflicts)
        raise DesignBridgeError(f"Refusing to overwrite existing generated documents: {joined}")

    for relative_path, text in documents.items():
        path = repo / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def _with_metadata(
    relative_path: Path,
    text: str,
    *,
    change_set_id: str,
    work_item_id: str = "",
    source_docs: tuple[Path, ...] = (),
    approval_status: str = "",
    status: str = "",
) -> str:
    metadata = infer_document_metadata(
        relative_path,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        source_docs=source_docs,
        approval_status=approval_status,
        status=status,
    )
    return apply_front_matter(text, {**metadata, **parse_front_matter(text)})


def _write_contracts(repo: Path, documents: dict[Path, str]) -> None:
    for relative_path, text in documents.items():
        metadata = parse_front_matter(text)
        if not metadata:
            continue
        source_docs = tuple(Path(path) for path in metadata.get("source_docs", ()))
        write_contract_sidecar(
            repo,
            relative_path,
            text,
            metadata,
            upstream_docs=source_docs,
        )


def _first_non_empty_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped
    return ""


def _escape_table(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def _escape_text(value: str) -> str:
    return value.replace("\n", " ").strip()


def _escape_fence(value: str) -> str:
    return value.replace("```", "` ` `").strip()
