import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TARGET_SKILLS = {
    "harness-requirements",
    "harness-usecases",
    "harness-event-storming",
    "harness-ddd-design",
    "harness-technical-decisions",
    "harness-code-planner",
    "harness-plan-executor",
    "harness-full-workflow",
}


def read_text(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def read_json(path: str) -> dict:
    return json.loads(read_text(path))


def test_skill_evaluation_guide_defines_core_contract() -> None:
    guide = read_text("docs/skill-evaluation.md")

    for skill_id in TARGET_SKILLS:
        assert skill_id in guide

    required_phrases = [
        "docs/skill-evaluation/prompt-corpus.json",
        "docs/skill-evaluation/assertion-schema.json",
        ".harness/skill-evaluations/<run-id>/",
        "with-skill results against baseline results",
        "./venv/bin/python3 -m pytest -q -s tests/test_skill_evaluation_contract.py",
    ]

    for phrase in required_phrases:
        assert phrase in guide


def test_prompt_corpus_covers_each_core_skill_once_or_more() -> None:
    corpus = read_json("docs/skill-evaluation/prompt-corpus.json")
    cases = corpus["cases"]
    skill_ids = {case["skill_id"] for case in cases}

    assert corpus["schema_version"] == "1.0"
    assert corpus["result_output_root"] == ".harness/skill-evaluations"
    assert skill_ids == TARGET_SKILLS

    for case in cases:
        assert case["id"].startswith(f"skill-{case['skill_id']}-")
        assert case["prompt"]
        assert case["expected_artifacts"]
        assert case["required_assertions"]
        assert "artifact_exists" in case["required_assertions"]
        assert "path_not_modified" in case["required_assertions"] or case["forbidden_paths"]


def test_assertion_schema_is_machine_checkable() -> None:
    schema = read_json("docs/skill-evaluation/assertion-schema.json")
    assertion_schema = schema["properties"]["assertions"]["items"]
    assertion_types = set(assertion_schema["properties"]["type"]["enum"])

    assert schema["properties"]["schema_version"]["const"] == "1.0"
    assert set(schema["required"]) == {
        "schema_version",
        "run_id",
        "case_id",
        "skill_id",
        "mode",
        "started_at",
        "ended_at",
        "metrics",
        "assertions",
    }
    assert {
        "artifact_exists",
        "heading_exists",
        "path_not_modified",
        "text_includes",
        "text_excludes",
        "json_path_equals",
        "metric_at_most",
        "metric_at_least",
    } <= assertion_types
    assert assertion_schema["additionalProperties"] is False


def test_generated_skill_evaluation_output_is_ignored() -> None:
    gitignore = read_text(".gitignore")

    assert ".harness/skill-evaluations/" in gitignore
