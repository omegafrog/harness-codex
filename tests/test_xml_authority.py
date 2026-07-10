from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.runtime_tool_contract import NAMESPACE as RUNTIME_TOOL_NAMESPACE
from harness_codex.runtime.subagent_contract import INVOCATION_NS, RESULT_NS
from harness_codex.runtime.xml_handoff import NAMESPACE as HANDOFF_NAMESPACE


def test_xml_authorities_have_one_distinct_boundary_each() -> None:
    root = Path(__file__).parents[1]

    assert len({INVOCATION_NS, RESULT_NS, RUNTIME_TOOL_NAMESPACE, HANDOFF_NAMESPACE}) == 4
    assert (root / "schemas/subagent-invocation-v1.xsd").is_file()
    assert (root / "schemas/subagent-result-v1.xsd").is_file()
    assert (root / "schemas/runtime-tool-request-v1.xsd").is_file()
    assert (root / "schemas/runtime-tool-result-v1.xsd").is_file()
    assert (root / "schemas/harness-handoff-v1.xsd").is_file()
    assert (root / "schemas/harness-state-v1.xsd").is_file()


def test_runtime_tool_contract_is_not_registered_as_workflow_handoff() -> None:
    source = (Path(__file__).parents[1] / "harness_codex/runtime/xml_handoff.py").read_text(encoding="utf-8")

    assert "runtime-tool-request" not in source
    assert "runtime-tool-result" not in source
    assert "subagent-invocation" not in source
    assert "subagent-result" not in source
