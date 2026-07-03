import json
from pathlib import Path

import pytest

from harness_codex.cli import main
from harness_codex.runtime.evolution import (
    EvolutionError,
    evolution_metrics,
    improve_evolution,
    promote_evolution,
    propose_evolution_from_episodes,
    render_accepted_evolution_context,
    replay_evolution,
)


def test_evolution_metrics_excludes_environment_blockers_from_quality_failures(
    tmp_path: Path,
) -> None:
    _write_episode(
        tmp_path,
        run_id="run-001",
        failure_class="implementation_failure",
        final_status="failed",
        duration_ms=10,
    )
    _write_episode(
        tmp_path,
        run_id="run-002",
        failure_class="environment_blocker",
        final_status="failed",
        duration_ms=30,
    )
    _write_episode(
        tmp_path,
        run_id="run-003",
        failure_class=None,
        final_status="succeeded",
        duration_ms=20,
    )

    metrics = evolution_metrics(tmp_path, change_set_id="CHG-001")

    assert metrics["episode_count"] == 3
    assert metrics["first_run_pass_rate"] == 0.3333
    assert metrics["failure_classes"]["environment_blocker"] == 1
    assert metrics["quality_failure_classes"] == {"implementation_failure": 1}
    assert metrics["duration_ms"]["p50"] == 20


def test_repeated_episode_pattern_requires_real_evaluation_before_promotion(
    tmp_path: Path,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    proposal = propose_evolution_from_episodes(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        min_count=2,
    )
    replay_path = replay_evolution(tmp_path, proposal.proposal_id)
    replay = json.loads((tmp_path / replay_path).read_text(encoding="utf-8"))

    assert proposal.proposal_id.startswith("EVO-")
    assert replay["status"] == "blocked"
    assert replay["reason"] == "candidate_execution_not_implemented"
    with pytest.raises(EvolutionError, match="isolated candidate evidence"):
        promote_evolution(
            tmp_path,
            proposal.proposal_id,
            canary_scope="work-item:UC-001",
        )
    assert not (tmp_path / ".harness/evolution/accepted" / f"{proposal.proposal_id}.md").exists()
    assert not (tmp_path / proposal.target_path).exists()


def test_improve_creates_review_artifacts_without_promoting(
    tmp_path: Path,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    result = improve_evolution(tmp_path)
    evaluation = json.loads((tmp_path / result.replay_path).read_text(encoding="utf-8"))
    promotion = json.loads(
        (tmp_path / result.promotion_state_path).read_text(encoding="utf-8")
    )

    assert evaluation["status"] == "pending"
    assert promotion["current"]["status"] == "pending_evaluation"
    assert result.canary_scope == "manual-approval-required"
    assert not (tmp_path / ".harness/evolution/accepted" / f"{result.proposal.proposal_id}.md").exists()
    assert not (tmp_path / result.proposal.target_path).exists()


def test_accepted_guidance_requires_promoted_scope_before_prompt_injection(
    tmp_path: Path,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")
    proposal = propose_evolution_from_episodes(tmp_path)

    proposal_text = (tmp_path / proposal.proposal_path).read_text(encoding="utf-8")
    accepted_text = proposal_text.replace("Reviewer decision: `pending`", "Reviewer decision: `accepted`")
    accepted_path = tmp_path / ".harness/evolution/accepted" / f"{proposal.proposal_id}.md"
    accepted_path.parent.mkdir(parents=True)
    accepted_path.write_text(accepted_text, encoding="utf-8")

    state_path = tmp_path / ".harness/evolution/promotion-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "current": {
                    "proposal_id": proposal.proposal_id,
                    "status": "canary",
                    "canary_scope": "work-item:UC-001",
                },
                "history": [
                    {
                        "proposal_id": proposal.proposal_id,
                        "status": "canary",
                        "canary_scope": "work-item:UC-001",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    visible = render_accepted_evolution_context(
        tmp_path,
        step_id="execute-work-item",
        work_item_id="UC-001",
    )
    hidden = render_accepted_evolution_context(
        tmp_path,
        step_id="execute-work-item",
        work_item_id="UC-999",
    )

    assert proposal.proposal_id in visible
    assert proposal.proposal_id not in hidden


def test_episode_pattern_rule_uses_failed_gate_before_generic_fallback(
    tmp_path: Path,
) -> None:
    _write_episode(
        tmp_path,
        run_id="run-001",
        failure_class="implementation_failure",
        failed_gates=["test-gate"],
        failed_commands=["python3 -m pytest tests/runtime"],
    )
    _write_episode(
        tmp_path,
        run_id="run-002",
        failure_class="implementation_failure",
        failed_gates=["test-gate"],
        failed_commands=["python3 -m pytest tests/runtime"],
    )

    result = improve_evolution(tmp_path)
    proposal_text = (tmp_path / result.proposal.proposal_path).read_text(encoding="utf-8")

    assert "run or record evidence for gate(s) test-gate" in proposal_text
    assert "python3 -m pytest tests/runtime" in proposal_text


def test_evolution_cli_improve_records_deferred_promotion(tmp_path: Path, capsys) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    exit_code = main(["--repo-root", str(tmp_path), "evolution", "improve"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "Evolution proposal created:" in output
    assert (tmp_path / ".harness/evolution/promotion-state.json").exists()
    assert (
        json.loads((tmp_path / ".harness/evolution/promotion-state.json").read_text(encoding="utf-8"))
        ["current"]["status"]
        == "pending_evaluation"
    )


def _write_episode(
    root: Path,
    *,
    run_id: str,
    failure_class: str | None,
    final_status: str = "failed",
    fingerprint: str = "fp-shared",
    duration_ms: int = 10,
    failed_gates: list[str] | None = None,
    failed_commands: list[str] | None = None,
) -> None:
    run_dir = root / ".harness/runs" / run_id
    run_dir.mkdir(parents=True)
    payload = {
        "schema_version": 1,
        "run_id": run_id,
        "changeset_id": "CHG-001",
        "work_item_ids": ["UC-001"],
        "workflow_version": "changeset-work-item-workflow",
        "agent_versions": {"implementation_executor": "unversioned"},
        "stages": [{"name": "verify-work-item", "duration_ms": duration_ms, "result": final_status}],
        "verification": {
            "result": "failed" if failure_class else "passed",
            "failure_class": failure_class,
            "failure_fingerprint": fingerprint if failure_class else None,
            "reports": [
                {
                    "failed_gates": failed_gates or [],
                    "failed_commands": [
                        {"command": command}
                        for command in (failed_commands or [])
                    ],
                    "unmet_obligations": [],
                }
            ],
        },
        "artifacts": {},
        "metrics": {},
        "final_status": final_status,
        "failure_class": failure_class,
        "failure_fingerprint": fingerprint if failure_class else None,
    }
    (run_dir / "episode.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
