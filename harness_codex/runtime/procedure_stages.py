"""ChangeSet-backed runtime procedure stages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class ProcedureStage:
    """One explicit runtime interface in the harness delivery sequence."""

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
        agent_id="harness_requirements",
        skill_id="harness-requirements",
        inputs=(Path("docs/changes/active/<CHG-ID>.md"),),
        outputs=(Path("context.md"), Path("docs/design/요구사항.md")),
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
        stage_id="plan-writing",
        display_name="plan.md Writing",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        inputs=(
            Path("docs/changes/active/<CHG-ID>.md"),
            Path("docs/use-cases/<UC-ID>/use-case.md"),
            Path("docs/use-cases/<UC-ID>/event-storming.md"),
            Path("docs/use-cases/<UC-ID>/ddd-design.md"),
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
        requires_uc=True,
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
    outputs = replace_stage_placeholders(
        stage.outputs,
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
    return f"""# ChangeSet {change_set_id}

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
- Reason for change: ChangeSet is the durable source of stage state from requirements through implementation.

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
    row = f"|{stage.stage_id}|{stage.display_name}|{status}|{now}|{notes or '-'}|"
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(f"|{stage.stage_id}|"):
            lines[index] = row
            return "\n".join(lines) + ("\n" if text.endswith("\n") else "")

    if "## 3. Runtime Procedure State" not in text:
        return text.rstrip() + "\n\n" + _procedure_state_section(row) + "\n"

    insert_at = len(lines)
    for index, line in enumerate(lines):
        if line.startswith("## ") and index > 0 and lines[index - 1].strip():
            insert_at = index
            break
    lines.insert(insert_at, row)
    return "\n".join(lines) + "\n"


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
