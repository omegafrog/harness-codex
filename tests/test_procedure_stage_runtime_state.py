import json
from argparse import Namespace
from pathlib import Path

from harness_codex import cli
from harness_codex.runtime.procedure_stage_runtime_state_patch import (
    apply_procedure_stage_runtime_state_patch,
)
from harness_codex.runtime.procedure_stages import procedure_stage, render_initial_changeset
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.changes import ChangeSetResolver
from harness_codex.runtime.state import (
    ArtifactDirtyState,
    RunState,
    RunStateStore,
    StageArtifactState,
    file_checksum,
)


def test_blocked_requirements_stage_does_not_create_artifact_conflict(tmp_path: Path) -> None:
    change_set_id = "CHG-TEST-001"
    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    requirements_path = Path("docs/design/요구사항.md")

    absolute_change_set_path = tmp_path / change_set_path
    absolute_change_set_path.parent.mkdir(parents=True)
    absolute_change_set_path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="파일 업로드 스케줄러 수정",
            request_summary="dev 서버에서 file_upload_job 테이블 누락으로 파일 업로드 스케줄러 실패",
        ),
        encoding="utf-8",
    )
    absolute_requirements_path = tmp_path / requirements_path
    absolute_requirements_path.parent.mkdir(parents=True)
    absolute_requirements_path.write_text("# 요구사항\n\n- 확인 질문 대기\n", encoding="utf-8")

    apply_procedure_stage_runtime_state_patch()
    cli._record_procedure_stage_status(
        tmp_path,
        change_set_path,
        procedure_stage("requirements-definition"),
        "blocked",
        "질문 응답 대기",
    )

    state = RunStateStore(tmp_path).load(f"changeset-state-{change_set_id}")
    artifact = next(item for item in state.artifact_states if item.stage == "requirements-definition")
    assert artifact.accepted is False
    assert artifact.dirty_state is ArtifactDirtyState.CLEAN
    assert artifact.checksum == file_checksum(absolute_requirements_path)

    handoff_path = tmp_path / ".harness/state/stage-handoff" / f"{change_set_id}.json"
    handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
    handoff_artifact = next(
        item for item in handoff["artifact_states"] if item["stage"] == "requirements-definition"
    )
    assert handoff_artifact["dirty_state"] == "clean"
    assert handoff_artifact["artifact"]["sha256"] == file_checksum(absolute_requirements_path)


def test_stage_handoff_repairs_legacy_blocked_artifact_conflict(tmp_path: Path) -> None:
    change_set_id = "CHG-TEST-002"
    requirements_path = Path("docs/design/요구사항.md")
    absolute_requirements_path = tmp_path / requirements_path
    absolute_requirements_path.parent.mkdir(parents=True)
    absolute_requirements_path.write_text("# 요구사항\n\n- 확인 질문 대기\n", encoding="utf-8")

    RunStateStore(tmp_path).save(
        RunState(
            run_id=f"changeset-state-{change_set_id}",
            change_set_id=change_set_id,
            workflow_name="changeset-runtime-state",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            status=RunStatus.PENDING,
            decision_results={
                "procedure_stage_results": {
                    "requirements-definition": {
                        "status": "blocked",
                        "notes": "질문 응답 대기",
                    }
                }
            },
            artifact_states=(
                StageArtifactState(
                    stage="requirements-definition",
                    path=requirements_path,
                    accepted=False,
                    dirty_state=ArtifactDirtyState.CONFLICT,
                ),
            ),
        )
    )

    cli._write_stage_handoff_state(tmp_path, change_set_id)

    state = RunStateStore(tmp_path).load(f"changeset-state-{change_set_id}")
    artifact = next(item for item in state.artifact_states if item.stage == "requirements-definition")
    assert artifact.dirty_state is ArtifactDirtyState.CLEAN
    assert artifact.checksum == file_checksum(absolute_requirements_path)

    handoff_path = tmp_path / ".harness/state/stage-handoff" / f"{change_set_id}.json"
    handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
    handoff_artifact = next(
        item for item in handoff["artifact_states"] if item["stage"] == "requirements-definition"
    )
    assert handoff_artifact["dirty_state"] == "clean"


def test_stages_list_uses_canonical_changeset_state(tmp_path: Path) -> None:
    change_set_id = "CHG-TEST-003"
    RunStateStore(tmp_path).save(
        RunState(
            run_id=f"changeset-state-{change_set_id}",
            change_set_id=change_set_id,
            workflow_name="changeset-runtime-state",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            status=RunStatus.PENDING,
            decision_results={
                "procedure_stage_results": {
                    "requirements-definition": {
                        "status": "blocked",
                        "notes": "질문 응답 대기",
                    }
                }
            },
        )
    )

    output = cli.stages_list_command(Namespace(change_set_id=change_set_id), tmp_path)

    assert "RunState: changeset-state-CHG-TEST-003" in output
    assert "requirements-definition\tblocked" in output


def test_changes_active_reports_early_changeset_without_work_items_as_in_progress(
    tmp_path: Path,
) -> None:
    change_set_id = "CHG-TEST-004"
    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    absolute_change_set_path = tmp_path / change_set_path
    absolute_change_set_path.parent.mkdir(parents=True)
    absolute_change_set_path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="파일 업로드 스케줄러 수정",
            request_summary="dev 서버에서 file_upload_job 테이블 누락",
        ),
        encoding="utf-8",
    )

    resolver = ChangeSetResolver(tmp_path)
    change_set = resolver.load(change_set_path)
    lines = cli._format_active_change_set(tmp_path, resolver, change_set)

    assert "Runtime status: PROCEDURE-IN-PROGRESS - affected work items are not defined yet" in lines
    assert "Next stage: requirements-definition (pending)" in lines
