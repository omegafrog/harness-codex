"""Convert Markdown review evidence into a fixed XML gate verdict."""

from __future__ import annotations

import re
from pathlib import Path

from harness_codex.runtime.xml_handoff import read_handoff, write_handoff

_PATCHED = "_harness_xml_review_gate_patch_applied"


def apply_xml_review_gate_patch() -> None:
    """Make plan and security review decisions consume XML verdicts only."""

    from harness_codex.runtime import runner

    if getattr(runner, _PATCHED, False):
        return

    original = runner._validate_review_gate

    def validate_review_gate(step, context):
        contract = step.metadata.get("review_gate")
        if not isinstance(contract, dict):
            return original(step, context)
        source_value = contract.get("output")
        label = str(contract.get("status_label") or "Review Status")
        approved = str(contract.get("approved_status") or "approved").casefold()
        if not isinstance(source_value, str) or not source_value:
            return "review gate XML contract requires an output path"
        source = context.repo_root / source_value
        if not source.is_file():
            return f"review gate evidence is missing: {source_value}"
        pattern = re.compile(
            rf"(?mi)^\s*{re.escape(label)}\s*:\s*([A-Za-z-]+)\s*$"
        )
        match = pattern.search(source.read_text(encoding="utf-8"))
        if match is None:
            return f"review gate evidence has no `{label}: ...` status line"
        observed = match.group(1).casefold()
        verdict_path = source.with_suffix(".xml")
        write_handoff(
            verdict_path,
            "gate-verdict",
            {
                "schema_version": 1,
                "gate_id": str(step.metadata.get("gate_id") or step.id),
                "status": "approved" if observed == approved else "rejected",
                "source_path": str(source_value),
                "status_label": label,
                "observed_status": observed,
            },
        )
        verdict = read_handoff(verdict_path, expected_type="gate-verdict")
        if verdict["status"] != "approved":
            return (
                f"{verdict['gate_id']} rejected by canonical XML verdict: "
                f"{verdict['observed_status']}"
            )
        return None

    runner._validate_review_gate = validate_review_gate
    setattr(runner, _PATCHED, True)
