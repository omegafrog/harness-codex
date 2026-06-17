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
    assert "affected use case" in oracle or "affected UC" in oracle


def test_oracle_keeps_canonical_event_storming_as_summary_index() -> None:
    oracle = read_doc(".codex/agents/oracle.toml")

    assert "summary/index context only" in oracle
    assert "planner/executor의 직접 입력은 UC slice 파일" in read_doc(
        ".codex/skills/harness-event-storming/SKILL.md"
    )


def test_oracle_blocks_only_the_affected_use_case_on_policy_gaps() -> None:
    oracle = read_doc(".codex/agents/oracle.toml")

    assert "return `blocked`" in oracle.lower()
    assert "upstream requirements or use-case stage" in oracle
    assert "Do not resolve actor goal" in oracle
    assert "user-visible behavior decisions in event storming" in oracle


def test_event_storming_runtime_contract_blocks_business_policy_questions() -> None:
    skill = read_doc(".codex/skills/harness-event-storming/SKILL.md")

    assert "Return `blocked`, not `needs_input`" in skill
    assert "missing actor goal" in skill
    assert "success/failure policy" in skill
    assert "validation policy" in skill
    assert "retention/source policy" in skill
    assert "user-visible behavior" in skill
