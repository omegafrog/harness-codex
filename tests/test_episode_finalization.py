import json
from pathlib import Path

from harness_codex.runtime.episode import write_run_episode
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.state import RunState, RunFailureKind
from harness_codex.runtime.xml_state import save_run_state


def test_episode_classifies_delivery_scope_conflict(tmp_path: Path) -> None:
    _write_run_fixture(
        tmp_path,
        blocker="BLOCKED: ChangeSet 범위 밖 변경을 스테이징하지 않고 보존했습니다: docs/plans/active/UC-002/plan.md",
    )

    path = write_run_episode(tmp_path, "run-test")
    episode = json.loads(path.read_text(encoding="utf-8"))

    assert episode["failure_class"] == "delivery_scope_conflict"
    assert episode["failure_fingerprint"]
    assert episode["finalization"]["failed_step_id"] == "create-change-set-pr"


def test_episode_classifies_delivery_gate_policy_conflict(tmp_path: Path) -> None:
    _write_run_fixture(
        tmp_path,
        blocker="BLOCKED: 실제 변경 파일에 필요한 검사가 ChangeSet 영향도에서 제외되어 있습니다: runtime-server",
    )

    path = write_run_episode(tmp_path, "run-test")
    episode = json.loads(path.read_text(encoding="utf-8"))

    assert episode["failure_class"] == "delivery_gate_policy_conflict"


def _write_run_fixture(root: Path, *, blocker: str) -> None:
    run_dir = root / ".harness/runs/run-test"
    (run_dir / "finalization").mkdir(parents=True)
    save_run_state(
        root,
        RunState(
            run_id="run-test",
            change_set_id="CHG-TEST-001",
            workflow_name="changeset-session",
            mode=RunMode.APPLY,
            status=RunStatus.FAILED,
            affected_work_items=("UC-001",),
            failure_kind=RunFailureKind.IMPLEMENTATION_FAILURE,
        ),
    )
    (run_dir / "report.json").write_text(
        json.dumps(
            {
                "run_id": "run-test",
                "change_set_id": "CHG-TEST-001",
                "workflow_name": "changeset-session",
                "status": "failed",
                "affected_use_cases": ["UC-001"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (run_dir / "events.ndjson").write_text("", encoding="utf-8")
    (run_dir / "metrics.json").write_text("{}", encoding="utf-8")
    (run_dir / "finalization/report.json").write_text(
        json.dumps(
            {
                "status": "failed",
                "failed_step_id": "create-change-set-pr",
                "failure_kind": "implementation",
                "blocker": blocker,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
