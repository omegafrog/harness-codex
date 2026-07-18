from __future__ import annotations

import ast
from pathlib import Path

from harness_codex.runtime.models import RunMode, Step, StepKind, Workflow


ROOT = Path(__file__).parents[1]


def test_runtime_models_have_no_concrete_workflow_instance() -> None:
    module = ast.parse((ROOT / "harness_codex/runtime/models.py").read_text(encoding="utf-8"))
    assignments = {
        target.id
        for node in module.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }

    assert "HARNESS_FULL_WORKFLOW" not in assignments


def test_runtime_accepts_fully_opaque_caller_workflow() -> None:
    workflow = Workflow(
        name="opaque-flow",
        mode=RunMode.PREVIEW,
        steps=(
            Step(id="arbitrary-one", kind=StepKind.RECORD, name="Caller action"),
            Step(
                id="arbitrary-two",
                kind=StepKind.VALIDATOR,
                name="Caller observation",
                needs=("arbitrary-one",),
            ),
        ),
    )

    assert workflow.step_ids() == ("arbitrary-one", "arbitrary-two")
    assert workflow.step_by_id("arbitrary-two").needs[0].step_id == "arbitrary-one"
