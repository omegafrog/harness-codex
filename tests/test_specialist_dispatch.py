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


class _ScaffoldAdapter:
    def __init__(self) -> None:
        self.request = None

    def run(self, request):
        self.request = request
        path = request.session_dir / "subagent-result.xml"
        root = ET.parse(path).getroot()
        outcome = root.find(f"{{{RESULT_NS}}}outcome")
        outcome.set("status", "succeeded")
        outcome.find(f"{{{RESULT_NS}}}summary").text = "approved"
        write_subagent_result(path, root)
        return AgentSessionResult(status="succeeded", termination_reason="completed", final_message="ok")


class _MutatingScaffoldAdapter(_ScaffoldAdapter):
    def run(self, request):
        result = super().run(request)
        path = request.session_dir / "subagent-result.xml"
        root = ET.parse(path).getroot()
        coverage = root.find(f"{{{RESULT_NS}}}review/{{{RESULT_NS}}}coverage")
        coverage.remove(coverage[0])
        write_subagent_result(path, root)
        return result


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
    paths = [item.get("path") for item in invocation.findall(f"{{{INVOCATION_NS}}}inputs/{{{INVOCATION_NS}}}artifact")]
    assert "docs/plans/active/MAINT-001/plan.md" in paths


def test_completed_specialist_result_normalizes_to_workflow_succeeded(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/skills/harness-code-planner").mkdir(parents=True)
    (tmp_path / ".codex/agents/implementation_planner.toml").write_text('name = "implementation_planner"\nmodel = "fake"\ndeveloper_instructions = "x"\n', encoding="utf-8")
    (tmp_path / ".codex/skills/harness-code-planner/SKILL.md").write_text("# sequence", encoding="utf-8")
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / ".codex/repository-settings.md").write_text("settings", encoding="utf-8")
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("# CHG-001", encoding="utf-8")
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")

    class _CompletedAdapter(_Adapter):
        def run(self, request):
            result = super().run(request)
            path = request.session_dir / "subagent-result.xml"
            root = ET.parse(path).getroot()
            root.find(f"{{{RESULT_NS}}}outcome").set("status", "completed")
            write_subagent_result(path, root)
            return result

    result = dispatch_specialist(repo_root=tmp_path, run_id="run-1", step_id="plan-work-item", change_set_id="CHG-001", work_item_id="MAINT-001", session_adapter=_CompletedAdapter())

    assert result.status == "succeeded"


def test_reviewer_uses_runtime_scaffold_with_immutable_coverage(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/skills/harness-artifact-reviewer").mkdir(parents=True)
    (tmp_path / ".codex/agents/artifact_reviewer.toml").write_text('name = "artifact_reviewer"\nmodel = "fake"\ndeveloper_instructions = "ROLE"\n', encoding="utf-8")
    (tmp_path / ".codex/skills/harness-artifact-reviewer/SKILL.md").write_text("SEQUENCE", encoding="utf-8")
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("# change", encoding="utf-8")
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")
    adapter = _ScaffoldAdapter()

    result = dispatch_specialist(repo_root=tmp_path, run_id="run-1", step_id="review-work-item-plan", change_set_id="CHG-001", work_item_id="MAINT-001", session_adapter=adapter)

    assert result.status == "succeeded"
    assert "ROLE" in adapter.request.prompt and "SEQUENCE" in adapter.request.prompt
    assert "Do not read agent, skill, prior-run" in adapter.request.prompt
    assert 'severity="blocking"' in adapter.request.prompt
    invocation = read_subagent_invocation(result.invocation_path)
    criteria = invocation.findall(f"{{{INVOCATION_NS}}}reviewTask/{{{INVOCATION_NS}}}criterion")
    assert [item.get("sourcePath") for item in criteria] == [
        "docs/changes/active/CHG-001.md",
        "docs/plans/active/MAINT-001/plan.md",
    ]
    output = ET.parse(result.result_path).getroot()
    assessed = output.findall(f"{{{RESULT_NS}}}review/{{{RESULT_NS}}}coverage/{{{RESULT_NS}}}assessed")
    assert [item.get("criterionRef") for item in assessed] == [item.get("id") for item in criteria]


def test_reviewer_cannot_mutate_runtime_owned_coverage(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/skills/harness-artifact-reviewer").mkdir(parents=True)
    (tmp_path / ".codex/agents/artifact_reviewer.toml").write_text('name = "artifact_reviewer"\nmodel = "fake"\ndeveloper_instructions = "ROLE"\n', encoding="utf-8")
    (tmp_path / ".codex/skills/harness-artifact-reviewer/SKILL.md").write_text("SEQUENCE", encoding="utf-8")
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("# change", encoding="utf-8")
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")

    result = dispatch_specialist(repo_root=tmp_path, run_id="run-1", step_id="review-work-item-plan", change_set_id="CHG-001", work_item_id="MAINT-001", session_adapter=_MutatingScaffoldAdapter())

    assert result.status == "blocked"
    assert result.fact == "subagent_protocol_failure"
