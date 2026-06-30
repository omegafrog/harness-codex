import json
from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.evolution import (
    evolution_metrics,
    improve_evolution,
    promote_evolution,
    propose_evolution_from_episodes,
    render_accepted_evolution_context,
    replay_evolution,
    rollback_evolution,
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


def test_repeated_episode_pattern_creates_evo_proposal_and_can_promote(
    tmp_path: Path,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")
    _write_episode(
        tmp_path,
        run_id="run-003",
        failure_class="environment_blocker",
        fingerprint="env-fp",
    )

    proposal = propose_evolution_from_episodes(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        min_count=2,
    )
    proposal_text = (tmp_path / proposal.proposal_path).read_text(encoding="utf-8")
    replay_path = replay_evolution(tmp_path, proposal.proposal_id)
    promoted_path = promote_evolution(
        tmp_path,
        proposal.proposal_id,
        canary_scope="work-item-type:use_case",
    )
    accepted_path = tmp_path / ".harness/evolution/accepted" / f"{proposal.proposal_id}.md"
    target_path = tmp_path / proposal.target_path
    accepted_context = render_accepted_evolution_context(
        tmp_path,
        step_id="execute-work-item",
    )

    assert proposal.proposal_id.startswith("EVO-")
    assert "- Source: `run_episode_pattern`" in proposal_text
    assert "run-001" in proposal_text
    assert "run-002" in proposal_text
    assert "run-003" not in proposal_text
    assert json.loads((tmp_path / replay_path).read_text(encoding="utf-8"))["status"] == "passed"
    assert accepted_path.exists()
    assert target_path.exists()
    assert f"### {proposal.proposal_id}.md" in accepted_context
    assert "Before leaving `verify-work-item`, verify its required artifact contract" in accepted_context
    rolled_back_path = rollback_evolution(tmp_path, proposal.proposal_id)
    state = json.loads((tmp_path / promoted_path).read_text(encoding="utf-8"))
    assert state["history"][-1]["status"] == "rolled_back"
    assert state["history"][-1]["removed_paths"] == [
        f".harness/evolution/accepted/{proposal.proposal_id}.md",
        str(proposal.target_path),
    ]
    assert not accepted_path.exists()
    assert not target_path.exists()
    assert promoted_path == rolled_back_path


def test_evolution_cli_episode_commands(tmp_path: Path, capsys) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "evolution",
            "propose-from-runs",
            "--change-set",
            "CHG-001",
            "--work-item",
            "UC-001",
        ]
    )
    output = capsys.readouterr().out
    proposal_id = next(
        path.stem
        for path in (tmp_path / ".harness/evolution/proposals").glob("EVO-*.md")
    )

    assert exit_code == 0
    assert "Evolution proposal created:" in output
    assert main(["--repo-root", str(tmp_path), "evolution", "metrics"]) == 0
    assert main(["--repo-root", str(tmp_path), "evolution", "replay", proposal_id]) == 0
    assert (
        main(
            [
                "--repo-root",
                str(tmp_path),
                "evolution",
                "promote",
                proposal_id,
                "--canary-scope",
                "work-item-type:use_case",
            ]
        )
        == 0
    )


def test_evolution_improve_auto_selects_pattern_replays_and_promotes(
    tmp_path: Path,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    result = improve_evolution(tmp_path)
    context = render_accepted_evolution_context(tmp_path, step_id="execute-work-item")

    assert result.canary_scope == "work-item:UC-001"
    assert (tmp_path / result.replay_path).exists()
    assert (tmp_path / result.promotion_state_path).exists()
    assert (tmp_path / ".harness/evolution/accepted" / f"{result.proposal.proposal_id}.md").exists()
    assert (tmp_path / result.proposal.target_path).exists()
    assert result.proposal.proposal_id in context


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
    context = render_accepted_evolution_context(tmp_path, step_id="execute-work-item")

    assert "run or record evidence for gate(s) test-gate" in context
    assert "python3 -m pytest tests/runtime" in (
        tmp_path / result.proposal.proposal_path
    ).read_text(encoding="utf-8")


def test_evolution_improve_cli_needs_no_change_set_or_work_item(
    tmp_path: Path,
    capsys,
) -> None:
    _write_episode(tmp_path, run_id="run-001", failure_class="implementation_failure")
    _write_episode(tmp_path, run_id="run-002", failure_class="implementation_failure")

    exit_code = main(["--repo-root", str(tmp_path), "evolution", "improve"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "Evolution proposal created:" in output
    assert "Replay recorded:" in output
    assert "Promotion recorded:" in output
    assert "Canary scope: work-item:UC-001" in output


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
