from __future__ import annotations

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.xml_handoff import read_handoff
from harness_codex.runtime.xml_review_gate_patch import apply_xml_review_gate_patch


def test_review_gate_uses_xml_verdict(tmp_path):
    apply_xml_review_gate_patch()
    source = tmp_path / "review.md"
    source.write_text("Review Status: approved\n", encoding="utf-8")
    step = Step(
        id="review",
        kind=StepKind.AGENT,
        name="review",
        metadata={"review_gate": {"output": "review.md", "status_label": "Review Status"}},
    )
    context = RunContext("run-1", "workflow", RunMode.APPLY, tmp_path, tmp_path, tmp_path)
    from harness_codex.runtime import runner

    assert runner._validate_review_gate(step, context) is None
    assert read_handoff(source.with_suffix(".xml"), expected_type="gate-verdict")["status"] == "approved"
