import json
from pathlib import Path

from harness_codex.runtime.episode import write_run_episode
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.state import RunFailureKind, RunState, RunStateStore


def test_write_run_episode_links_state_reports_and_safe_verification_summary(tmp_path: Path) -> None:
    run_id = "run-episode"
    run_dir = tmp_path / ".harness/runs" / run_id
    verification_dir = run_dir / "work-items/UC-001/verification"
    verification_dir.mkdir(parents=True)
    RunStateStore(tmp_path).save(
        RunState(
            run_id=run_id,
            change_set_id="CHG-001",
            workflow_name="changeset-work-item-workflow",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            affected_work_items=("UC-001",),
            status=RunStatus.FAILED,
        )
    )
    (run_dir / "report.json").write_text(
        '{"run_id":"run-episode","change_set_id":"CHG-001","status":"failed"}',
        encoding="utf-8",
    )
    (run_dir / "events.ndjson").write_text(
        "\n".join(
            (
                '{"event_type":"run.started","run_id":"run-episode"}',
                '{"event_type":"step.finished","run_id":"run-episode","step_id":"verify-work-item","step_kind":"validator","status":"failed","duration_ms":12.5}',
            )
        )
        + "\n",
        encoding="utf-8",
    )
    (run_dir / "metrics.json").write_text(
        '{"event_count":2,"status_counts":{"failed":1},"bottlenecks":[]}',
        encoding="utf-8",
    )
    (run_dir / "materialized-workflow-UC-001.json").write_text(
        '{"name":"changeset-work-item-workflow","steps":[{"agent_id":"implementation_executor"}]}',
        encoding="utf-8",
    )
    (verification_dir / "report.json").write_text(
        json.dumps(
            {
                "status": "FAIL",
                "failure_class": "implementation_failure",
                "failure_fingerprint": "fp-001",
                "failed_commands": [
                    {
                        "command": "python3 -m pytest",
                        "stderr_path": ".harness/runs/run-episode/work-items/UC-001/verification/command-01/stderr.txt",
                    }
                ],
                "evidence": ["stderr: safe-path-only"],
                "stderr": "must-not-copy-raw-stderr",
                "prompt": "must-not-copy-prompt",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    path = write_run_episode(tmp_path, run_id)

    episode = json.loads(path.read_text(encoding="utf-8"))
    encoded = json.dumps(episode, ensure_ascii=False)
    assert episode["changeset_id"] == "CHG-001"
    assert episode["work_item_ids"] == ["UC-001"]
    assert episode["agent_versions"] == {"implementation_executor": "unversioned"}
    assert episode["verification"]["failure_class"] == "implementation_failure"
    assert episode["failure_fingerprint"] == "fp-001"
    assert episode["stages"][0]["name"] == "verify-work-item"
    assert "must-not-copy-raw-stderr" not in encoded
    assert "must-not-copy-prompt" not in encoded


def test_write_run_episode_derives_fingerprint_for_legacy_run_without_verification_report(
    tmp_path: Path,
) -> None:
    run_id = "run-legacy"
    RunStateStore(tmp_path).save(
        RunState(
            run_id=run_id,
            change_set_id="CHG-001",
            workflow_name="changeset-work-item-workflow",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            affected_work_items=("UC-001",),
            status=RunStatus.FAILED,
            failure_kind=RunFailureKind.IMPLEMENTATION_FAILURE,
            failed_step_id="verify-work-item",
        )
    )

    path = write_run_episode(tmp_path, run_id)

    episode = json.loads(path.read_text(encoding="utf-8"))
    assert episode["failure_class"] == "implementation_failure"
    assert episode["failure_fingerprint"]
