from types import SimpleNamespace

from harness_codex.runtime.ddd_candidate_efficiency_patch import _targets_for_uc


def test_targets_for_uc_groups_all_unfinished_sections_in_one_candidate() -> None:
    ui = SimpleNamespace(
        DDD_STEPS=(
            ("entity_vo", "Entity / Value Objects"),
            ("behaviors", "Behaviors"),
            ("application_flow", "Application Flow"),
            ("aggregates", "Aggregates"),
            ("bounded_contexts", "Bounded Contexts"),
        )
    )
    state = {
        "items": {
            "UC-031": {
                "steps": {
                    "entity_vo": {"status": "complete"},
                    "behaviors": {"status": "pending"},
                    "application_flow": {"status": "error"},
                    "aggregates": {"status": "stale"},
                    "bounded_contexts": {"status": "pending"},
                }
            }
        }
    }

    assert _targets_for_uc(ui, state, "UC-031") == [
        {"uc_id": "UC-031", "step_id": "behaviors", "label": "Behaviors"},
        {"uc_id": "UC-031", "step_id": "application_flow", "label": "Application Flow"},
        {"uc_id": "UC-031", "step_id": "aggregates", "label": "Aggregates"},
        {"uc_id": "UC-031", "step_id": "bounded_contexts", "label": "Bounded Contexts"},
    ]
