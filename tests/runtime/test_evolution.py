from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.evolution import (
    EvolutionError,
    accept_evolution,
    classify_failure_for_evolution,
    propose_evolution,
)


def test_failure_classification_marks_missing_verification_as_eligible() -> None:
    result = classify_failure_for_evolution(
        "Plan completed with no command evidence and missing verification step."
    )

    assert result.status == "eligible"
    assert result.component == "verification"


def test_propose_evolution_writes_experience_and_reviewable_proposal(tmp_path: Path) -> None:
    _write_failed_run(
        tmp_path,
        run_id="run-001",
        work_item_id="UC-001",
        report='{"status": "FAIL", "blocker": "missing verification step"}',
    )

    proposal = propose_evolution(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        run_id="run-001",
    )

    proposal_text = (tmp_path / proposal.proposal_path).read_text(encoding="utf-8")
    assert proposal.proposal_id.startswith("EVO-")
    assert proposal.classification.status == "eligible"
    assert (tmp_path / proposal.experience_dir / "trajectory-summary.md").exists()
    assert "Reviewer decision: `pending`" in proposal_text
    assert "Target path: `.harness/evolution/components/verification/" in proposal_text


def test_accept_evolution_materializes_only_allowed_component_path(tmp_path: Path) -> None:
    _write_failed_run(
        tmp_path,
        run_id="run-001",
        work_item_id="UC-001",
        report='{"status": "FAIL", "blocker": "missing verification step"}',
    )
    proposal = propose_evolution(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        run_id="run-001",
    )

    accepted_path, target_path = accept_evolution(tmp_path, proposal.proposal_id)

    assert (tmp_path / accepted_path).exists()
    assert (tmp_path / target_path).exists()
    assert target_path.parts[:4] == (
        ".harness",
        "evolution",
        "components",
        "verification",
    )
    assert "Reviewer decision: `accepted`" in (tmp_path / target_path).read_text(
        encoding="utf-8"
    )


def test_accept_evolution_rejects_protected_path(tmp_path: Path) -> None:
    proposal_dir = tmp_path / ".harness/evolution/proposals"
    proposal_dir.mkdir(parents=True)
    (proposal_dir / "EVO-20260603-001.md").write_text(
        "\n".join(
            [
                "# Evolution Proposal",
                "",
                "## Proposed Mutable Component Change",
                "",
                "- Target path: `harness_codex/runtime/runner.py`",
                "",
                "## Reviewer Decision",
                "",
                "- Reviewer decision: `pending`",
            ]
        ),
        encoding="utf-8",
    )

    try:
        accept_evolution(tmp_path, "EVO-20260603-001")
    except EvolutionError as error:
        assert ".harness/evolution/components/" in str(error)
    else:
        raise AssertionError("protected path should be rejected")


def test_evolution_cli_propose_accept_reject(tmp_path: Path, capsys) -> None:
    _write_failed_run(
        tmp_path,
        run_id="run-001",
        work_item_id="UC-001",
        report='{"status": "FAIL", "blocker": "missing verification step"}',
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "evolution",
            "propose",
            "--change-set",
            "CHG-001",
            "--work-item",
            "UC-001",
            "--run-id",
            "run-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Evolution proposal created:" in output
    proposal_id = next(
        path.stem
        for path in (tmp_path / ".harness/evolution/proposals").glob("EVO-*.md")
    )

    exit_code = main(
        ["--repo-root", str(tmp_path), "evolution", "accept", proposal_id]
    )
    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Component updated:" in output

    exit_code = main(
        ["--repo-root", str(tmp_path), "evolution", "reject", proposal_id]
    )
    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Evolution proposal rejected:" in output


def _write_failed_run(
    root: Path,
    *,
    run_id: str,
    work_item_id: str,
    report: str,
) -> None:
    verification_dir = (
        root / ".harness/runs" / run_id / "work-items" / work_item_id / "verification"
    )
    verification_dir.mkdir(parents=True)
    (verification_dir / "report.json").write_text(report, encoding="utf-8")
    run_dir = root / ".harness/runs" / run_id
    (run_dir / "report.md").write_text(
        "# Run Report\n\n- Status: failed\n",
        encoding="utf-8",
    )
