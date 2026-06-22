"""README-defined ChangeSet procedure stages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re

from harness_codex.runtime.completion import PlanCompletionBlocked, validate_plan_completion


@dataclass(frozen=True)
class ProcedureStage:
    """One explicit command in the README workflow."""

    stage_id: str
    display_name: str
    agent_id: str | None
    skill_id: str | None
    inputs: tuple[Path, ...]
    outputs: tuple[Path, ...]
    verifier_terms: tuple[str, ...] = ()
    requires_uc: bool = False


PROCEDURE_STAGES: tuple[ProcedureStage, ...] = (
    ProcedureStage(
        stage_id="requirements-definition",
        display_name="Requirements Definition",
        agent_id="requirements_interviewer",
        skill_id="harness-requirements",
        inputs=(Path("docs/changes/active/<CHG-ID>.md"),),
        outputs=(Path("docs/design/요구사항.md"),),
        verifier_terms=("TBD from confirmed requirements",),
    ),
    ProcedureStage(
        stage_id="ubiquitous-language-definition",
        display_name="Ubiquitous Language Definition",
        agent_id="ubiquitous_language_reviewer",
        skill_id="harness-ubiquitous-language",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/design/요구사항.md"),
        ),
        outputs=(Path("context.md"),),
        verifier_terms=("TBD from confirmed requirements",),
    ),
    ProcedureStage(
        stage_id="use-case-definition",
        display_name="Use Case Definition",
        agent_id="harness_usecases",
        skill_id="harness-usecases",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("context.md"),
            Path("docs/design/요구사항.md"),
        ),
        outputs=(Path("docs/design/유스케이스.md"), Path("docs/use-cases")),
        verifier_terms=("TBD from confirmed requirements",),
    ),
    ProcedureStage(
        stage_id="event-storming",
        display_name="Event Storming",
        agent_id="oracle",
        skill_id="harness-event-storming",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/use-cases/<UC-ID>/use-case.md"),
            Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
        ),
        outputs=(Path("docs/use-cases/<UC-ID>/event-storming.md"),),
        verifier_terms=("has not been derived yet", "To be derived"),
        requires_uc=True,
    ),
    ProcedureStage(
        stage_id="ddd-architecture-definition",
        display_name="DDD Architecture Definition",
        agent_id="ddd_architect",
        skill_id="harness-ddd-design",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/use-cases/<UC-ID>/use-case.md"),
            Path("docs/use-cases/<UC-ID>/event-storming.md"),
        ),
        outputs=(Path("docs/use-cases/<UC-ID>/ddd-design.md"), Path("ARCHITECTURE.md")),
        verifier_terms=("TBD", "To be derived"),
        requires_uc=True,
    ),
    ProcedureStage(
        stage_id="technical-decisions",
        display_name="Technical Decisions",
        agent_id="technical_decisions",
        skill_id="harness-technical-decisions",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/use-cases/<UC-ID>/use-case.md"),
            Path("docs/use-cases/<UC-ID>/event-storming.md"),
            Path("docs/use-cases/<UC-ID>/ddd-design.md"),
            Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
            Path("ARCHITECTURE.md"),
        ),
        outputs=(Path("docs/use-cases/<UC-ID>/technical-decisions.md"),),
        verifier_terms=("TBD", "To be derived", "Needs confirmation", "|Approval Status|pending|"),
        requires_uc=True,
    ),
    ProcedureStage(
        stage_id="plan-writing",
        display_name="plan.md Writing",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/use-cases/<UC-ID>/use-case.md"),
            Path("docs/use-cases/<UC-ID>/event-storming.md"),
            Path("docs/use-cases/<UC-ID>/ddd-design.md"),
            Path("docs/use-cases/<UC-ID>/technical-decisions.md"),
            Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
            Path("ARCHITECTURE.md"),
            Path(".codex/repository-settings.md"),
        ),
        outputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
        verifier_terms=("TBD", "To be derived"),
        requires_uc=True,
    ),
    ProcedureStage(
        stage_id="implementation",
        display_name="Implementation",
        agent_id="implementation_executor",
        skill_id="harness-plan-executor",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/plans/active/<UC-ID>/plan.md"),
            Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
            Path(".codex/test-gate.yaml"),
        ),
        outputs=(Path("docs/plans/completed/<UC-ID>/plan.md"),),
    ),
)

PROCEDURE_STAGE_BY_ID = {stage.stage_id: stage for stage in PROCEDURE_STAGES}


def procedure_stage(stage_id: str) -> ProcedureStage:
    try:
        return PROCEDURE_STAGE_BY_ID[stage_id]
    except KeyError as exc:
        known = ", ".join(stage.stage_id for stage in PROCEDURE_STAGES)
        raise ValueError(f"unknown procedure stage: {stage_id}. Known: {known}") from exc


def replace_stage_placeholders(
    paths: tuple[Path, ...],
    *,
    change_set_id: str,
    uc_id: str | None = None,
) -> tuple[Path, ...]:
    return tuple(
        Path(
            str(path)
            .replace("<CHG-ID>", change_set_id)
            .replace("<UC-ID>", uc_id or "<UC-ID>")
        )
        for path in paths
    )


def stage_outputs_for_run(
    stage: ProcedureStage,
    *,
    change_set_id: str,
    uc_id: str | None = None,
) -> tuple[Path, ...]:
    if stage.stage_id == "use-case-definition" and uc_id:
        return (
            Path("docs/design/유스케이스.md"),
            Path("docs/use-cases") / uc_id / "use-case.md",
            Path("docs/use-cases") / uc_id / "e2e-goal.md",
        )
    return replace_stage_placeholders(
        stage.outputs,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )


def verify_procedure_stage(
    repo_root: Path,
    stage: ProcedureStage,
    *,
    change_set_id: str,
    uc_id: str | None = None,
) -> tuple[bool, tuple[str, ...]]:
    if stage.requires_uc and not uc_id:
        return False, (f"{stage.stage_id} requires --uc",)

    problems: list[str] = []
    outputs = stage_outputs_for_run(
        stage,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )
    for output in outputs:
        absolute = repo_root / output
        if not absolute.exists():
            problems.append(f"missing output: {output}")
            continue
        if absolute.is_file() and not absolute.read_text(encoding="utf-8").strip():
            problems.append(f"empty output: {output}")
            continue
        if absolute.is_file():
            text = absolute.read_text(encoding="utf-8")
            for term in stage.verifier_terms:
                if term and term in text:
                    problems.append(f"unverified placeholder in {output}: {term}")

    if stage.stage_id == "implementation" and uc_id:
        active_plan = Path("docs/plans/active") / uc_id / "plan.md"
        if (repo_root / active_plan).exists():
            problems.append(f"active plan remains: {active_plan}")
        completed_plan = Path("docs/plans/completed") / uc_id / "plan.md"
        if (repo_root / completed_plan).exists():
            try:
                validate_plan_completion(
                    repo_root,
                    completed_plan,
                    change_set_id=change_set_id,
                    work_item_id=uc_id,
                )
            except PlanCompletionBlocked as exc:
                problems.append(f"incomplete plan output: {exc.reason}")
            completed_text = (repo_root / completed_plan).read_text(encoding="utf-8")
            foreign_change_sets = sorted(
                {
                    match
                    for match in re.findall(r"\bCHG-\d{8}-\d+\b", completed_text)
                    if match != change_set_id
                }
            )
            if foreign_change_sets:
                problems.append(
                    "completed plan references other ChangeSet IDs: "
                    + ", ".join(foreign_change_sets)
                )
    return not problems, tuple(problems)


def render_initial_changeset(
    *,
    change_set_id: str,
    title: str,
    request_summary: str,
) -> str:
    rows = "\n".join(
        f"|{stage.stage_id}|{stage.display_name}|pending|-|-|"
        for stage in PROCEDURE_STAGES
    )
    display_title = title or request_summary or change_set_id
    return f"""# {display_title}

## 1. Metadata

|Item|Value|
|---|---|
|ChangeSet ID|`{change_set_id}`|
|Status|active|
|Created date|{datetime.now().strftime("%Y-%m-%d")}|
|Author|Codex|

## 2. Implementation Intent

- Request summary: {request_summary or title}
- Expected user result: The runtime can resume each stage from this ChangeSet.
- State source of truth: `.harness/runs/<run-id>/state.json` (`RunState`) is authoritative for runtime stage, gate, artifact acceptance, dirty/downstream state, failure kind, and resume target.
- Procedure table role: this table is a durable user-facing mirror of `RunState`; reconcile it before using it for planning or dashboard status.

## 3. Runtime Procedure State

|Stage ID|Procedure|Status|Verified At|Notes|
|---|---|---|---|---|
{rows}
"""


def update_changeset_stage_status(
    text: str,
    *,
    stage: ProcedureStage,
    status: str,
    notes: str = "",
) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = f"|{stage.stage_id}|{stage.display_name}|{status}|{now}|{_escape_table_cell(notes or '-')}|"
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(f"|{stage.stage_id}|"):
            lines[index] = row
            return _sort_procedure_rows("\n".join(lines) + ("\n" if text.endswith("\n") else ""))

    if "## 3. Runtime Procedure State" not in text:
        return text.rstrip() + "\n\n" + _procedure_state_section(row) + "\n"

    insert_at = len(lines)
    for index, line in enumerate(lines):
        if line.startswith("## ") and index > 0 and lines[index - 1].strip():
            insert_at = index
            break
    lines.insert(insert_at, row)
    return _sort_procedure_rows("\n".join(lines) + "\n")


def parse_procedure_stage_rows(text: str) -> tuple[dict[str, str], ...]:
    section = _section_text(text, "## 3. Runtime Procedure State")
    rows: list[dict[str, str]] = []
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and cells[0] not in ("Stage ID", "---"):
            rows.append(
                {
                    "id": cells[0],
                    "procedure": cells[1],
                    "status": cells[2],
                    "verified_at": cells[3],
                    "notes": cells[4].replace("\\|", "|"),
                }
            )
    return tuple(rows)


def _procedure_state_section(first_row: str) -> str:
    return "\n".join(
        [
            "## 3. Runtime Procedure State",
            "",
            "|Stage ID|Procedure|Status|Verified At|Notes|",
            "|---|---|---|---|---|",
            first_row,
        ]
    )


def _sort_procedure_rows(text: str) -> str:
    lines = text.splitlines()
    stage_order = {stage.stage_id: index for index, stage in enumerate(PROCEDURE_STAGES)}
    row_indexes: list[int] = []
    rows: list[str] = []
    for index, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        stage_id = line.split("|", maxsplit=2)[1]
        if stage_id in stage_order:
            row_indexes.append(index)
            rows.append(line)
    if len(rows) < 2:
        return text

    rows.sort(key=lambda line: stage_order[line.split("|", maxsplit=2)[1]])
    for index, row in zip(row_indexes, rows):
        lines[index] = row
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def _section_text(text: str, heading: str) -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    end = text.find("\n## ", start + len(heading))
    return text[start : end if end >= 0 else len(text)]


def _escape_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
