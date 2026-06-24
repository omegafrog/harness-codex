from pathlib import Path
import subprocess

from harness_codex.cli import main
from harness_codex.runtime.evolution import accept_evolution, propose_evolution, record_intent_feedback


def _git_repository(root: Path) -> None:
    (root / "README.md").write_text("# test repository\n", encoding="utf-8")
    for command in (
        ("git", "init"),
        ("git", "config", "user.email", "test@example.com"),
        ("git", "config", "user.name", "Harness Test"),
        ("git", "add", "README.md"),
        ("git", "commit", "-m", "initial"),
    ):
        subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)


def _write_run(root: Path, *, run_id: str = "run-001") -> None:
    (root / ".harness/runs" / run_id).mkdir(parents=True)


def _feedback() -> dict[str, str]:
    return {
        "run_id": "run-001",
        "work_item_id": "UC-001",
        "step_id": "plan-work-item",
        "interaction_phase": "follow_up",
        "agent_question": "Should all stages be regenerated?",
        "agent_recommended_answer": "Regenerate all stages.",
        "user_answer": "Use only the current active stage.",
        "agent_assumption": "All stages were in scope.",
        "correction": "Completed stages are outside the requested scope.",
        "intent_delta": "Preserve completed stages.",
        "misalignment_kind": "workflow_stage",
        "reusable_rule": "Preserve completed stages unless explicitly included.",
    }


def _completed_evidence(root: Path) -> None:
    change = root / "docs/changes/completed/CHG-001.md"
    plan = root / "docs/plans/completed/UC-001/plan.md"
    change.parent.mkdir(parents=True, exist_ok=True)
    plan.parent.mkdir(parents=True, exist_ok=True)
    change.write_text("# ChangeSet CHG-001\n", encoding="utf-8")
    plan.write_text("# Completed plan\n", encoding="utf-8")


def _proposal(root: Path):
    _write_run(root)
    record_intent_feedback(root, _feedback())
    return propose_evolution(
        root,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        run_id="run-001",
    )


def test_accept_evolution_defers_memory_until_completed_evidence_exists(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    proposal = _proposal(tmp_path)

    accepted_path, _target_path = accept_evolution(tmp_path, proposal.proposal_id)
    accepted_text = (tmp_path / accepted_path).read_text(encoding="utf-8")

    assert "Status: `deferred`" in accepted_text
    assert "Reason: `changeset_not_completed`" in accepted_text
    assert not (tmp_path / "docs/memory").exists()


def test_accept_evolution_promotes_verified_completed_guidance_to_review_learning(
    tmp_path: Path,
) -> None:
    _git_repository(tmp_path)
    _completed_evidence(tmp_path)
    proposal = _proposal(tmp_path)

    accepted_path, _target_path = accept_evolution(tmp_path, proposal.proposal_id)
    accepted_text = (tmp_path / accepted_path).read_text(encoding="utf-8")
    memory_paths = tuple((tmp_path / "docs/memory/review-learnings").glob("MEM-*.md"))

    assert len(memory_paths) == 1
    memory_text = memory_paths[0].read_text(encoding="utf-8")
    assert "kind: review_learning" in memory_text
    assert "status: verified" in memory_text
    assert "Preserve completed stages unless explicitly included." in memory_text
    assert "Status: `recorded`" in accepted_text
    assert ".harness/memory-index/memory-index.json" not in accepted_text
    assert (tmp_path / ".harness/memory-index/memory-index.json").exists()


def test_evolution_accept_cli_can_be_rerun_to_promote_a_deferred_candidate(
    tmp_path: Path, capsys
) -> None:
    _git_repository(tmp_path)
    proposal = _proposal(tmp_path)

    first = main(
        ["--repo-root", str(tmp_path), "evolution", "accept", proposal.proposal_id]
    )
    assert first == 0
    assert "Component updated:" in capsys.readouterr().out
    _completed_evidence(tmp_path)

    second = main(
        ["--repo-root", str(tmp_path), "evolution", "accept", proposal.proposal_id]
    )
    assert second == 0
    assert "Component updated:" in capsys.readouterr().out
    assert len(tuple((tmp_path / "docs/memory/review-learnings").glob("MEM-*.md"))) == 1
