from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.orchestration.specialist_dispatch import dispatch_specialist
from harness_codex.runtime.agent_session import AgentSessionResult
from harness_codex.runtime.subagent_contract import INVOCATION_NS, RESULT_NS, read_subagent_invocation, write_subagent_result


class _Adapter:
    def __init__(self) -> None:
        self.request = None

    def run(self, request):
        self.request = request
        invocation = read_subagent_invocation(request.session_dir / "subagent-invocation.xml")
        identity = invocation.find(f"{{{INVOCATION_NS}}}identity")
        delegate = invocation.find(f"{{{INVOCATION_NS}}}delegate")
        result = ET.Element(f"{{{RESULT_NS}}}subagent-result", {"schemaVersion": "1"})
        ET.SubElement(result, f"{{{RESULT_NS}}}identity", dict(identity.attrib))
        ET.SubElement(result, f"{{{RESULT_NS}}}delegate", dict(delegate.attrib))
        outcome = ET.SubElement(result, f"{{{RESULT_NS}}}outcome", {"status": "succeeded"})
        ET.SubElement(outcome, f"{{{RESULT_NS}}}summary").text = "ok"
        ET.SubElement(result, f"{{{RESULT_NS}}}artifacts")
        ET.SubElement(result, f"{{{RESULT_NS}}}evidence")
        ET.SubElement(result, f"{{{RESULT_NS}}}changes")
        ET.SubElement(result, f"{{{RESULT_NS}}}blockers")
        write_subagent_result(request.session_dir / "subagent-result.xml", result)
        return AgentSessionResult(status="succeeded", termination_reason="completed", final_message="ok")


def test_runtime_dispatcher_owns_existing_xml_handoff(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text(
        (source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/skills/harness-code-planner").mkdir(parents=True)
    (tmp_path / ".codex/agents/implementation_planner.toml").write_text('name = "implementation_planner"\nmodel = "fake"\ndeveloper_instructions = "x"\n', encoding="utf-8")
    (tmp_path / ".codex/skills/harness-code-planner/SKILL.md").write_text("# sequence", encoding="utf-8")
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / ".codex/repository-settings.md").write_text("settings", encoding="utf-8")
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("# CHG-001", encoding="utf-8")
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")
    adapter = _Adapter()

    result = dispatch_specialist(repo_root=tmp_path, run_id="run-1", step_id="plan-work-item", change_set_id="CHG-001", work_item_id="MAINT-001", session_adapter=adapter)

    assert result.status == "succeeded"
    assert result.invocation_path.name == "subagent-invocation.xml"
    assert result.result_path.name == "subagent-result.xml"
    assert adapter.request.agent_config["name"] == "implementation_planner"
    invocation = read_subagent_invocation(result.invocation_path)
    assert invocation.find(f"{{{INVOCATION_NS}}}delegate").get("skillId") == "harness-code-planner"
