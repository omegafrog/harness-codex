import json

from harness_codex.runtime import harvest_ui


def test_grill_me_question_turn_keeps_at_most_three_questions() -> None:
    result = harvest_ui._parse_grill_me_turn_json(
        json.dumps(
            {
                "complete": False,
                "questions": [
                    {"question": "Question 1", "recommended": "Answer 1"},
                    {"question": "Question 2", "recommended": "Answer 2"},
                    {"question": "Question 3", "recommended": "Answer 3"},
                    {"question": "Question 4", "recommended": "Answer 4"},
                ],
            }
        )
    )

    assert [item["question"] for item in result["questions"]] == [
        "Question 1",
        "Question 2",
        "Question 3",
    ]


def test_grill_me_prompt_allows_one_to_three_questions() -> None:
    prompt = harvest_ui._grill_me_prompt(
        {
            "initial_prompt": "Build a queue system.",
            "clarifications": [],
            "current_question": None,
            "current_questions": [],
        }
    )

    assert "between 1 and 3 question objects" in prompt
    assert "Ask no more than 3 focused questions" in prompt
    assert "exactly 1 question" not in prompt
