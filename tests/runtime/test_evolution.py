from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.evolution import (
    EvolutionError,
    accept_evolution,
    classify_failure_for_evolution,
    propose_evolution,
    record_intent_feedback,
)
from harness_codex.runtime.models import HARNESS_FULL_WORKFLOW


def test_verifier_failure_is_not_eligible_for_evolution() -> None:
    result = classify_failure_for_evolution(
        "Plan completed with no command evidence and missing verification step."
    )

    assert result.status == "not_eligible"
    assert result.component == "verification"


def test_intent_feedback_event_produces_reviewable_proposal(tmp_path: Path) -> None:
    _write_run(tmp_path, run_id="run-001")
    feedback_path = record_intent_feedback(
        tmp_path,
        _intent_feedback(run_id="run-001", work_item_id="UC-001"),
    )

    proposal = propose_evolution(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        run_id="run-001",
    )

    proposal_text = (tmp_path / proposal.proposal_path).read_text(encoding="utf-8")
    assert feedback_path == Path(".harness/runs/run-001/intent-feedback.jsonl")
    assert proposal.proposal_id.startswith("EVO-")
    assert proposal.classification.status == "eligible"
    assert proposal.classification.component == "runner-policy"
    assert (tmp_path / proposal.experience_dir / "trajectory-summary.md").exists()
    assert (tmp_path / proposal.experience_dir / "intent-feedback.json").exists()
    assert "Reviewer decision: `pending`" in proposal_text
    assert "Target path: `.harness/evolution/components/runner-policy/" in proposal_text
    assert "existing artifact verifier and contract gate" in proposal_text


def test_verifier_failure_report_cannot_produce_proposal(tmp_path: Path) -> None:
    _write_run(tmp_path, run_id="run-001")
    verification_dir = (
        tmp_path
        / ".harness/runs/run-001/work-items/UC-001/verification"
    )
    verification_dir.mkdir(parents=True)
    (verification_dir / "report.json").write_text(
        '{"status": "FAIL", "blocker": "missing verification step"}',
        encoding="utf-8",
    )

    try:
        propose_evolution(
            tmp_path,
            change_set_id="CHG-001",
            work_item_id="UC-001",
            run_id="run-001",
        )
    except EvolutionError as error:
        assert "no intent-alignment feedback" in str(error)
    else:
        raise AssertionError("verifier failure must not produce an evolution proposal")


def test_accept_evolution_materializes_guidance_only(tmp_path: Path) -> None:
    _write_run(tmp_path, run_id="run-001")
    record_intent_feedback(
        tmp_path,
        _intent_feedback(run_id="run-001", work_item_id="UC-001"),
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
        "runner-policy",
    )
    assert target_path.suffix == ".md"
    assert "Reviewer decision: `accepted`" in (tmp_path / target_path).read_text(
        encoding="utf-8"
    )


def test_accept_evolution_rejects_contract_template_workflow_and_runtime_paths(
    tmp_path: Path,
) -> None:
    protected_paths = (
        "harness_codex/runtime/runner.py",
        ".harness/docs/templates/plans/verification.md",
        ".harness/workflows/default.yaml",
        "docs/use-cases/UC-001/plan.md",
    )
    proposal_dir = tmp_path / ".harness/evolution/proposals"
    proposal_dir.mkdir(parents=True)

    for index, protected_path in enumerate(protected_paths, start=1):
        proposal_id = f"EVO-20260603-{index:03d}"
        (proposal_dir / f"{proposal_id}.md").write_text(
            "\n".join(
                [
                    "# Evolution Proposal",
                    "",
                    "## Proposed Mutable Component Change",
                    "",
                    "- Classification: `eligible`",
                    f"- Target path: `{protected_path}`",
                    "",
                    "## Reviewer Decision",
                    "",
                    "- Reviewer decision: `pending`",
                ]
            ),
            encoding="utf-8",
        )

        try:
            accept_evolution(tmp_path, proposal_id)
        except EvolutionError as error:
            assert ".harness/evolution/components/" in str(error)
        else:
            raise AssertionError(f"protected path should be rejected: {protected_path}")


def test_regenerated_artifact_still_requires_existing_verifier_before_handoff() -> None:
    verifier = HARNESS_FULL_WORKFLOW.step_by_id("verifier-run-implementation-e2e")
    decision = HARNESS_FULL_WORKFLOW.step_by_id(
        "classify-use-case-verification-result"
    )

    assert verifier.needs == ("executor-implement-use-case-plan",)
    assert decision.needs == ("verifier-run-implementation-e2e",)


def test_evolution_cli_propose_accept_reject(tmp_path: Path, capsys) -> None:
    _write_run(tmp_path, run_id="run-001")
    record_intent_feedback(
        tmp_path,
        _intent_feedback(run_id="run-001", work_item_id="UC-001"),
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


def _write_run(root: Path, *, run_id: str) -> None:
    (root / ".harness/runs" / run_id).mkdir(parents=True)


def _intent_feedback(*, run_id: str, work_item_id: str) -> dict[str, str]:
    return {
        "run_id": run_id,
        "work_item_id": work_item_id,
        "step_id": "plan-work-item",
        "interaction_phase": "follow_up",
        "agent_question": "Should all workflow stages be regenerated?",
        "agent_recommended_answer": "Regenerate every stage.",
        "user_answer": "Use only the latest workflow stage.",
        "agent_assumption": "All stages were in scope.",
        "correction": "The user excluded completed stages.",
        "intent_delta": "Limit regeneration to the latest active stage.",
        "misalignment_kind": "workflow_stage",
        "reusable_rule": "Preserve completed stages unless the user includes them.",
    }
