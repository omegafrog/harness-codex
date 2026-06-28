from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_text(relative: str) -> str:
    return (REPO_ROOT / relative).read_text(encoding="utf-8")


def test_spring_package_structure_preserves_repository_taxonomy() -> None:
    text = read_text(".codex/skills/spring-package-structure/references/package-rules.md")

    assert "Package taxonomy is user-owned architecture" in text
    assert "ui/application/domain/infra" in text
    assert "Do not translate them to `controller`, `service`, `presentation`, or `infrastructure`" in text
    assert "must not gain sibling `controller`, `service`, or `infrastructure` packages" in text


def test_planner_preserves_package_taxonomy() -> None:
    text = read_text(".codex/skills/harness-code-planner/references/plan-rules.md") + "\n" + read_text(
        ".codex/skills/harness-code-planner/references/detailed-instructions.md"
    )

    assert "Package taxonomy must be preserved exactly" in text
    assert "Do not plan new package names by Spring convention" in text
    assert "If a module uses `ui/application/domain/infra`" in text
    assert "must not introduce `controller`, `service`, `presentation`, or `infrastructure` siblings" in text


def test_executor_preserves_package_taxonomy() -> None:
    text = "\n".join(
        [
            read_text(".codex/agents/implementation_executor.toml"),
            read_text(".codex/agents/references/implementation_executor.md"),
            read_text(".codex/skills/harness-implementation-executor/SKILL.md"),
        ]
    )

    assert "Preserve the repository package taxonomy exactly" in text
    assert "If the module uses `ui/application/domain/infra`" in text
    assert "Do not create `controller`, `service`, `presentation`, or `infrastructure` siblings" in text
