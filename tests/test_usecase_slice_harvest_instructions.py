from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_contract(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.name == "SKILL.md":
        detailed = path.parent / "references/detailed-instructions.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    if path.suffix == ".toml":
        detailed = path.parent / "references" / f"{path.stem}.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_usecase_harvester_writes_runtime_ready_slice_docs() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
        REPO_ROOT / ".harness/workflows/harvest-workflow.yaml",
    )

    for path in paths:
        text = read_contract(path)
        assert "docs/use-cases" in text
        assert "use-case.md" in text
        assert "e2e-goal.md" in text
