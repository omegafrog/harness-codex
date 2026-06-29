from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = REPO_ROOT / ".codex/skills/harness-implementation-executor/references/ddd-implementation-policy.md"


def test_executor_declares_fixed_ddd_policy_as_control_plane() -> None:
    config = (REPO_ROOT / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")
    reference = (REPO_ROOT / ".codex/agents/references/implementation_executor.md").read_text(encoding="utf-8")
    skill = (REPO_ROOT / ".codex/skills/harness-implementation-executor/SKILL.md").read_text(encoding="utf-8")

    assert str(POLICY_PATH.relative_to(REPO_ROOT)) in config
    assert str(POLICY_PATH.relative_to(REPO_ROOT)) in reference
    assert str(POLICY_PATH.relative_to(REPO_ROOT)) in skill
    assert "sole task-specific product and implementation instruction" in reference


def test_fixed_ddd_policy_covers_layer_dependency_and_domain_rules() -> None:
    policy = POLICY_PATH.read_text(encoding="utf-8")

    required_rules = [
        "ui -> application -> domain",
        "domain` must not depend on `application`, `ui`, `infra`",
        "Aggregate Root",
        "Repository Ports",
        "Application Services must not",
        "Domain Service",
        "Port",
        "Transaction",
        "Domain Events",
        "Architecture Checks",
        "Required Plan Handoff",
    ]

    for rule in required_rules:
        assert rule in policy
