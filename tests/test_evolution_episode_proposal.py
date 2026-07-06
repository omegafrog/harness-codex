from harness_codex.runtime.evolution import (
    _dominant_failed_stage,
    _episode_reusable_rule,
)


def test_evolution_uses_finalization_failed_step_as_stage() -> None:
    stage = _dominant_failed_stage(
        (
            {
                "finalization": {
                    "failed_step_id": "create-change-set-pr",
                    "failure_class": "delivery_scope_conflict",
                },
                "stages": [
                    {
                        "name": "review-work-item-plan",
                        "result": "blocked",
                    }
                ],
            },
        )
    )

    assert stage == "finalization/create-change-set-pr"


def test_evolution_rule_for_delivery_scope_conflict_is_specific() -> None:
    rule = _episode_reusable_rule(
        failure_class="delivery_scope_conflict",
        repeated_stage="finalization/create-change-set-pr",
        failed_gates=(),
        failed_commands=(),
        unmet_obligations=(),
    )

    assert "final branch diff" in rule
    assert "branch history" in rule
