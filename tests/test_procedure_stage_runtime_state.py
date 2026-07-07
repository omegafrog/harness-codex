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


def test_requirements_stage_creates_handoff_before_first_interactive_turn(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_set_id = "CHG-TEMP-TEST-001"
    handoff_path = tmp_path / ".harness/state/stage-handoff" / f"{change_set_id}.json"

    def fake_grill_me(repo_root, run_dir, prompt, label):
        assert handoff_path.is_file()
        assert f"`{handoff_path.relative_to(tmp_path)}`" in prompt
        return json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "changed_files": [],
                "blocker": "테스트 차단",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_grill_me)
    monkeypatch.setattr(cli, "_interactive_stage_noninteractive", lambda: True)

    output = cli.procedure_stage_command(
        Namespace(
            procedure_stage_id="requirements-definition",
            change_set_id=change_set_id,
            uc="",
            title="테스트 요구사항",
            idea="첫 실행 전에 handoff JSON이 준비되어야 한다.",
            plan=False,
            preview=False,
            apply=True,
            force=True,
        ),
        tmp_path,
    )

    assert "Stage: requirements-definition" in output
    assert handoff_path.is_file()


def test_stage_handoff_drops_resolved_missing_handoff_blocker(tmp_path: Path) -> None:
    change_set_id = "CHG-TEST-005"
    handoff_relative = Path(".harness/state/stage-handoff") / f"{change_set_id}.json"
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
                        "notes": f"Required handoff JSON is missing: {handoff_relative}",
                    },
                    "use-case-definition": {
                        "status": "blocked",
                        "notes": "실제 요구사항 모순",
                    },
                }
            },
        )
    )

    cli._write_stage_handoff_state(tmp_path, change_set_id)

    state = RunStateStore(tmp_path).load(f"changeset-state-{change_set_id}")
    assert "requirements-definition" not in state.decision_results["procedure_stage_results"]

    handoff = json.loads((tmp_path / handoff_relative).read_text(encoding="utf-8"))
    stage_results = handoff["stage_results"]
    assert "requirements-definition" not in stage_results
    assert stage_results["use-case-definition"]["notes"] == "실제 요구사항 모순"


def test_stage_handoff_repairs_stale_markdown_blocked_mirror_from_runstate(
    tmp_path: Path,
) -> None:
    change_set_id = "CHG-TEST-007"
    change_set_path = tmp_path / "docs/changes/active" / f"{change_set_id}.md"
    requirements_path = tmp_path / "docs/design/요구사항.md"
    change_set_path.parent.mkdir(parents=True)
    requirements_path.parent.mkdir(parents=True)
    requirements_path.write_text("# 요구사항\n\n- 완료\n", encoding="utf-8")
    text = render_initial_changeset(
        change_set_id=change_set_id,
        title="상태 동기화 테스트",
        request_summary="stale markdown mirror 복구",
    )
    stale_text = text.replace(
        "|requirements-definition|Requirements Definition|pending|-|-|",
        (
            "|requirements-definition|Requirements Definition|blocked|old|"
            "Required handoff JSON is missing|"
        ),
    )
    change_set_path.write_text(stale_text, encoding="utf-8")

    RunStateStore(tmp_path).save(
        RunState(
            run_id=f"changeset-state-{change_set_id}",
            change_set_id=change_set_id,
            workflow_name="changeset-runtime-state",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            status=RunStatus.PENDING,
            artifact_states=(
                StageArtifactState(
                    stage="requirements-definition",
                    path=Path("docs/design/요구사항.md"),
                    accepted=True,
                    dirty_state=ArtifactDirtyState.CLEAN,
                    downstream_status=ArtifactDirtyState.CLEAN,
                    checksum=file_checksum(requirements_path),
                ),
            ),
        )
    )

    cli._write_stage_handoff_state(tmp_path, change_set_id)

    handoff = json.loads(
        (
            tmp_path / ".harness/state/stage-handoff" / f"{change_set_id}.json"
        ).read_text(encoding="utf-8")
    )
    assert handoff["stage_results"]["requirements-definition"]["status"] == "verified"

    repaired_text = change_set_path.read_text(encoding="utf-8")
    assert "|requirements-definition|Requirements Definition|verified|" in repaired_text
    assert "Required handoff JSON is missing" not in repaired_text


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


def test_changes_active_reports_preplanning_stage_before_missing_work_item_docs(
    tmp_path: Path,
) -> None:
    change_set_id = "CHG-TEST-006"
    change_set_path = Path("docs/changes/active") / f"{change_set_id}.md"
    absolute_change_set_path = tmp_path / change_set_path
    absolute_change_set_path.parent.mkdir(parents=True)
    absolute_change_set_path.write_text(
        f"""# 파일 업로드 스케줄러 수정

## 1. Metadata

|Item|Value|
|---|---|
|ChangeSet ID|`{change_set_id}`|
|Status|active|

## 3. Runtime Procedure State

|Stage ID|Procedure|Status|Verified At|Notes|
|---|---|---|---|---|
|requirements-definition|Requirements Definition|verified|2026-07-06T00:00:00Z|ok|
|ubiquitous-language-definition|Ubiquitous Language Definition|verified|2026-07-06T00:00:00Z|ok|
|use-case-definition|Use Case Definition|verified|2026-07-06T00:00:00Z|ok|
|event-storming|Event Storming|verified|2026-07-06T00:00:00Z|ok|
|ddd-architecture-definition|DDD Architecture Definition|pending|-|-|
|ddd-design-integration|DDD Design Integration|pending|-|-|
|technical-decisions|Technical Decisions|pending|-|-|
|plan-writing|plan.md Writing|pending|-|-|
|implementation|Implementation|pending|-|-|
|change-set-pr|ChangeSet PR|pending|-|-|

## 5. Affected Use Cases

|Use Case ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|UC-001|파일 업로드 링크 스케줄러 복구|update|docs/use-cases/UC-001|ready|

## 6. Affected Work Items

|Work Item ID|Type|Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|---|
|UC-001|use_case|파일 업로드 링크 스케줄러 복구|update|docs/use-cases/UC-001|ready|
""",
        encoding="utf-8",
    )
    use_case_dir = tmp_path / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True)
    (use_case_dir / "use-case.md").write_text("# UC-001\n", encoding="utf-8")
    (use_case_dir / "e2e-goal.md").write_text("# E2E\n", encoding="utf-8")
    (use_case_dir / "event-storming.md").write_text("# Event Storming\n", encoding="utf-8")

    resolver = ChangeSetResolver(tmp_path)
    change_set = resolver.load(change_set_path)
    lines = cli._format_active_change_set(tmp_path, resolver, change_set)

    assert (
        "Runtime status: PROCEDURE-IN-PROGRESS - procedure stages are not ready for work-item planning"
        in lines
    )
    assert "Next stage: ddd-architecture-definition (pending)" in lines
    assert not any("missing required documents" in line for line in lines)
