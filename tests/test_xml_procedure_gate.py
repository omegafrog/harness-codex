from __future__ import annotations

import pytest

import harness_codex.runtime  # noqa: F401
from harness_codex.runtime import dashboard_runtime_state as canonical


def test_procedure_gate_rejects_legacy_snapshot_without_xml(tmp_path):
    change_set_id = "CHG-XML-GATE-001"
    path = tmp_path / ".harness/ui/change-sets" / change_set_id / "harvest-session.json"
    path.parent.mkdir(parents=True)
    path.write_text('{"requirements_gate_passed": true}', encoding="utf-8")

    with pytest.raises(ValueError, match="canonical XML state is missing"):
        canonical.assert_canonical_stage_gate(
            tmp_path,
            change_set_id,
            "ubiquitous-language-definition",
        )
