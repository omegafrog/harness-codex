from harness_codex.runtime.runner import BasicStepRunner


def test_work_item_plan_state_guard_wraps_basic_step_runner() -> None:
    assert BasicStepRunner.run.__module__ == (
        "harness_codex.runtime.work_item_plan_state_guard"
    )
