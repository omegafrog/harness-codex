import re
import subprocess
import sys
from pathlib import Path

from harness_codex.runtime.evolution import record_intent_feedback


SOURCE_ROOT = Path(__file__).resolve().parents[3]


def _run_harness(repo_root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "harness_codex",
            "--repo-root",
            str(repo_root),
            *arguments,
        ],
        cwd=SOURCE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def _git_repository(root: Path) -> None:
    (root / "README.md").write_text("# CLI E2E repository\n", encoding="utf-8")
    for command in (
        ("git", "init"),
        ("git", "config", "user.email", "test@example.com"),
        ("git", "config", "user.name", "Harness Test"),
        ("git", "add", "README.md"),
        ("git", "commit", "-m", "initial"),
    ):
        completed = subprocess.run(
            command,
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr


def _write_completed_evidence(root: Path) -> None:
    change = root / "docs/changes/completed/CHG-CLI-001.md"
    plan = root / "docs/plans/completed/UC-CLI-001/plan.md"
    change.parent.mkdir(parents=True, exist_ok=True)
    plan.parent.mkdir(parents=True, exist_ok=True)
    change.write_text("# Completed ChangeSet\n", encoding="utf-8")
    plan.write_text("# Completed Work Item Plan\n", encoding="utf-8")


def _record_feedback(root: Path) -> None:
    (root / ".harness/runs/run-cli-001").mkdir(parents=True)
    record_intent_feedback(
        root,
        {
            "run_id": "run-cli-001",
            "work_item_id": "UC-CLI-001",
            "step_id": "plan-work-item",
            "interaction_phase": "follow_up",
            "agent_question": "Regenerate every workflow stage?",
            "agent_recommended_answer": "Regenerate every stage.",
            "user_answer": "Keep completed stages untouched.",
            "agent_assumption": "Every stage is in scope.",
            "correction": "Completed stages must remain unchanged.",
            "intent_delta": "Limit changes to the active stage.",
            "misalignment_kind": "workflow_stage",
            "reusable_rule": "Preserve completed stages unless the user includes them.",
        },
    )


def test_public_cli_promotes_accepted_evolution_and_searches_the_result(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    _write_completed_evidence(tmp_path)
    _record_feedback(tmp_path)

    proposal = _run_harness(
        tmp_path,
        "evolution",
        "propose",
        "--change-set",
        "CHG-CLI-001",
        "--work-item",
        "UC-CLI-001",
        "--run-id",
        "run-cli-001",
    )
    assert proposal.returncode == 0, proposal.stderr
    proposal_id = re.search(r"EVO-\d{8}-\d{3}", proposal.stdout)
    assert proposal_id is not None, proposal.stdout

    accepted = _run_harness(tmp_path, "evolution", "accept", proposal_id.group(0))
    assert accepted.returncode == 0, accepted.stderr
    assert "Evolution proposal accepted:" in accepted.stdout
    assert "Component updated:" in accepted.stdout

    listed = _run_harness(tmp_path, "memory", "list", "--kind", "review_learning")
    assert listed.returncode == 0, listed.stderr
    assert "review_learning" in listed.stdout
    assert "docs/memory/review-learnings/MEM-" in listed.stdout

    searched = _run_harness(
        tmp_path,
        "memory",
        "search",
        "intent-alignment",
        "--kind",
        "review_learning",
        "--stage",
        "plan",
    )
    assert searched.returncode == 0, searched.stderr
    assert "reference_only=true" in searched.stdout
    assert "source=docs/changes/completed/CHG-CLI-001.md" in searched.stdout

    reindexed = _run_harness(tmp_path, "memory", "reindex")
    assert reindexed.returncode == 0, reindexed.stderr
    assert ".harness/memory-index/memory-index.json" in reindexed.stdout
    assert (tmp_path / ".harness/memory-index/memory-index.json").is_file()
    assert not (tmp_path / ".harness/memory/index.yaml").exists()


def test_public_cli_rejects_the_retired_memory_score_subcommand(tmp_path: Path) -> None:
    _git_repository(tmp_path)

    result = _run_harness(tmp_path, "memory", "score", "candidate.yaml")

    assert result.returncode == 2
    assert "invalid choice" in result.stderr
    assert "score" in result.stderr
