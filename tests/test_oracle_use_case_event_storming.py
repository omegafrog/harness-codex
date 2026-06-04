from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_doc(path: str) -> str:
    absolute = REPO_ROOT / path
    text = absolute.read_text(encoding="utf-8")
    if absolute.name == "SKILL.md":
        detailed = absolute.parent / "references/detailed-instructions.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    if absolute.suffix == ".toml":
        detailed = absolute.parent / "references" / f"{absolute.stem}.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_oracle_writes_affected_use_case_event_storming_slice() -> None:
    oracle = read_doc(".codex/agents/oracle.toml")

    assert "docs/changes/active/<CHG-ID>.md" in oracle
    assert "docs/use-cases/<UC-ID>/use-case.md" in oracle
    assert "docs/use-cases/<UC-ID>/e2e-goal.md" in oracle
    assert "docs/use-cases/<UC-ID>/event-storming.md" in oracle
    assert "Do not create per-use-case event storming files" not in oracle
    assert "Do not write event-storming content for unaffected use cases" in oracle


def test_oracle_keeps_canonical_event_storming_as_summary_index() -> None:
    oracle = read_doc(".codex/agents/oracle.toml")

    assert (
        "Maintain docs/design/이벤트 스토밍.md, when present, as a summary/index"
        in oracle
    )
    assert "planner/executor의 직접 입력은 UC slice 파일" in read_doc(
        ".codex/skills/harness-event-storming/SKILL.md"
    )


def test_oracle_blocks_only_the_affected_use_case_on_policy_gaps() -> None:
    oracle = read_doc(".codex/agents/oracle.toml")

    assert "write or update the current event-storming draft" in oracle
    assert "Needs confirmation" in oracle
    assert "affected UC is blocked" in oracle
    assert "resolve only that UC's policies" in oracle
