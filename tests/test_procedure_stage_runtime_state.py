import json
from pathlib import Path

from harness_codex import cli
from harness_codex.runtime.procedure_stage_runtime_state_patch import (
    apply_procedure_stage_runtime_state_patch,
)
from harness_codex.runtime.procedure_stages import procedure_stage, render_initial_changeset
from harness_codex.runtime.state import ArtifactDirtyState, RunStateStore, file_checksum


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
