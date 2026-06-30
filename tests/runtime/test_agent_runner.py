import json
import subprocess
from dataclasses import replace
from pathlib import Path

import harness_codex.runtime.runner as runner_module
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import (
    AgentRunRequest,
    AgentRunResult,
    BasicStepRunner,
    CodexCliAgentAdapter,
    ConfigurableCliAgentAdapter,
    _implementation_completion_prompt_suffix,
    _restore_invalid_completed_plan,
)
from harness_codex.runtime.completion import validate_plan_completion


class FakeAgentAdapter:
    def __init__(
        self,
        result: AgentRunResult | None = None,
        *,
        write_outputs: bool = True,
    ) -> None:
        self.requests: list[AgentRunRequest] = []
        self.result = result or AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={"fake": True},
        )
        self.write_outputs = write_outputs

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.requests.append(request)
        if self.write_outputs and self.result.status == StepStatus.SUCCEEDED:
            for output in request.step.outputs:
                target = request.context.repo_root / output
                if output.suffix:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("generated output\n", encoding="utf-8")
                else:
                    target.mkdir(parents=True, exist_ok=True)
        return self.result


class ReviewAgentAdapter(FakeAgentAdapter):
    def __init__(self, review_text: str) -> None:
        super().__init__()
        self.review_text = review_text

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.requests.append(request)
        for output in request.step.outputs:
            target = request.context.repo_root / output
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(self.review_text, encoding="utf-8")
        return self.result


def context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "affected_work_items": [{"id": "UC-001", "type": "use_case"}],
        },
    )


def write_agent_config(repo_root: Path, agent_id: str = "implementation_planner") -> None:
    agents_dir = repo_root / ".codex/agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / f"{agent_id}.toml").write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "test agent"',
                'model = "gpt-5.4"',
                'model_reasoning_effort = "medium"',
                'sandbox_mode = "workspace-write"',
                'developer_instructions = """테스트 지시문"""',
            ]
        ),
        encoding="utf-8",
    )


def init_git_repo(repo_root: Path) -> None:
    subprocess.run(["git", "init"], cwd=repo_root, check=True, capture_output=True)


def write_executor_scope_fixture(repo_root: Path) -> None:
    write_agent_config(repo_root, "implementation_executor")
    plan = repo_root / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "\n".join(
            [
                "# Implementation Plan",
                "",
                "- Change allowed file: `src/main/java/com/example/ticketing/reservation/ReservationService.java`",
            ]
        ),
        encoding="utf-8",
    )
    change_set = repo_root / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True, exist_ok=True)
    change_set.write_text(
        "\n".join(
            [
                "# ChangeSet CHG-001",
                "",
                "## 1. Metadata",
                "|Item|Value|",
                "|---|---|",
                "|ChangeSet ID|`CHG-001`|",
                "|Status|active|",
                "",
                "## 8. Scope Boundary",
                "### Included",
                "- `src/main/java/com/example/ticketing/reservation/**`",
                "- `src/test/java/com/example/ticketing/reservation/**`",
                "",
                "### Excluded",
                "- `src/main/java/com/example/ticketing/payment/**`",
            ]
        ),
        encoding="utf-8",
    )


def executor_context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001/UC-001",
        active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
            "affected_work_items": [
                {
                    "id": "UC-001",
                    "type": "use_case",
                    "executor_inputs": [
                        "docs/plans/active/UC-001/plan.md",
                        "docs/use-cases/UC-001/affected-files.md",
                    ],
                }
            ],
        },
    )


def executor_step() -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute plan",
        agent_id="implementation_executor",
        skill_id=None,
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )


def test_implementation_executor_prompt_requires_completion_evidence(
    tmp_path: Path,
) -> None:
    suffix = _implementation_completion_prompt_suffix(
        executor_step(),
        executor_context(tmp_path),
    )

    assert "Runtime completion contract:" in suffix
    assert (
        ".harness/runs/run-001/UC-001/steps/execute-work-item/evidence/build.txt"
        in suffix
    )
    assert "E2E 또는 maintenance verification: PASS" in suffix


def test_invalid_completed_plan_is_restored_for_retry(tmp_path: Path) -> None:
    run_context = executor_context(tmp_path)
    completed = Path("docs/plans/completed/UC-001/plan.md")
    active = Path("docs/plans/active/UC-001/plan.md")
    completed_path = tmp_path / completed
    completed_path.parent.mkdir(parents=True)
    completed_path.write_text("# Invalid completed plan\n", encoding="utf-8")

    _restore_invalid_completed_plan(
        run_context,
        completed_plan=completed,
        active_plan=active,
    )

    assert not completed_path.exists()
    assert (tmp_path / active).read_text(encoding="utf-8") == "# Invalid completed plan\n"


class FileEditingAgentAdapter:
    def __init__(self, edits: dict[str, str]) -> None:
        self.edits = edits
        self.requests: list[AgentRunRequest] = []

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.requests.append(request)
        for path, text in self.edits.items():
            target = request.context.repo_root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={"fake": True},
        )


def write_skill(repo_root: Path, skill_id: str = "harness-code-planner") -> None:
    skill_dir = repo_root / ".codex/skills" / skill_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {skill_id}",
                "description: test skill",
                "---",
                "",
                "# 테스트 스킬",
                "스킬 호출 확인용 지시문",
            ]
        ),
        encoding="utf-8",
    )


def write_completed_plan(
    repo_root: Path,
    *,
    unchecked: bool = False,
    empty_result: str | None = None,
    missing_evidence: bool = False,
) -> Path:
    plan_path = repo_root / "docs/plans/active/UC-001/plan.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_dir = repo_root / ".harness/runs/run-001/steps/final-verification"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence_files = {
        "build": ".harness/runs/run-001/steps/final-verification/build.txt",
        "tests": ".harness/runs/run-001/steps/final-verification/tests.txt",
        "e2e": ".harness/runs/run-001/steps/final-verification/e2e.txt",
        "gate": ".harness/runs/run-001/steps/final-verification/test-gate.txt",
        "runtime": ".harness/runs/run-001/steps/final-verification/runtime.txt",
        "static": ".harness/runs/run-001/steps/final-verification/static-analysis.txt",
    }
    for path in evidence_files.values():
        if missing_evidence and path.endswith("static-analysis.txt"):
            continue
        target = repo_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("pass\n", encoding="utf-8")

    checkbox = "- [ ] Remaining task" if unchecked else "- [x] Implemented task"
    results = {
        "Build": f"PASS `{evidence_files['build']}`",
        "Tests": f"PASS `{evidence_files['tests']}`",
        "E2E 또는 maintenance verification": f"PASS `{evidence_files['e2e']}`",
        "Test gate": f"PASS `{evidence_files['gate']}`",
        "Runtime server verification": f"PASS `{evidence_files['runtime']}`",
        "Static analysis": f"PASS `{evidence_files['static']}`",
    }
    if empty_result is not None:
        results[empty_result] = ""

    decisions_path = repo_root / "docs/use-cases/UC-001/technical-decisions.md"
    decisions_path.parent.mkdir(parents=True, exist_ok=True)
    decisions_path.write_text(
        "# Technical Decisions\n\nApproved decision: Test gate.\n",
        encoding="utf-8",
    )
    plan_path.write_text(
        "\n".join(
            [
                "# Implementation Plan",
                "",
                "## 1. 구현 목표",
                "- ChangeSet: CHG-001",
                "- Work item: UC-001",
                "",
                "## 6. 구현 계획",
                checkbox,
                "",
                "## 8. 검증 방법",
                "- [x] Build:",
                "- [x] Tests:",
                "- [x] E2E 또는 maintenance verification:",
                "- [x] Test gate:",
                "- [x] Runtime server verification:",
                "- [x] Static analysis:",
                "",
                "## 9. 완료 조건",
                "- 모든 체크박스가 `- [x]` 상태다.",
                "",
                "## 10. 검증 결과",
                f"- Build: {results['Build']}",
                f"- Tests: {results['Tests']}",
                f"- E2E 또는 maintenance verification: {results['E2E 또는 maintenance verification']}",
                f"- Test gate: {results['Test gate']}",
                f"- Runtime server verification: {results['Runtime server verification']}",
                f"- Static analysis: {results['Static analysis']}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return plan_path


def write_changeset_ready_for_completion(repo_root: Path, *, active_plan: bool = False) -> None:
    active_changeset = repo_root / "docs/changes/active/CHG-001.md"
    active_changeset.parent.mkdir(parents=True, exist_ok=True)
    active_changeset.write_text(
        "\n".join(
            [
                "# ChangeSet CHG-001",
                "",
                "## 1. 메타데이터",
                "|항목|값|",
                "|---|---|",
                "|ChangeSet ID|`CHG-001`|",
                "|상태|active|",
                "",
                "## 5. 영향 유스케이스",
                "|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|",
                "|---|---|---|---|---|",
                "|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|",
                "",
            ]
        ),
        encoding="utf-8",
    )
    completed_plan = repo_root / "docs/plans/completed/UC-001/plan.md"
    completed_plan.parent.mkdir(parents=True, exist_ok=True)
    completed_plan.write_text("# Completed Plan\n", encoding="utf-8")
    if active_plan:
        active = repo_root / "docs/plans/active/UC-001/plan.md"
        active.parent.mkdir(parents=True, exist_ok=True)
        active.write_text("# Active Plan\n", encoding="utf-8")

    run_dir = repo_root / ".harness/runs/run-001"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "report.json").write_text(
        json.dumps(
            {
                "run_id": "run-001",
                "change_set_id": "CHG-001",
                "workflow_name": "changeset-use-case-workflow",
                "mode": "apply",
                "status": "succeeded",
                "affected_use_cases": ["UC-001"],
                "failed_use_cases": [],
                "blocked_use_cases": [],
                "work_item_reports": [
                    {
                        "work_item_id": "UC-001",
                        "work_item_type": "use_case",
                        "active_plan_path": "docs/plans/active/UC-001/plan.md",
                        "completed_plan_path": "docs/plans/completed/UC-001/plan.md",
                        "status": "succeeded",
                        "verification_goal_path": "docs/use-cases/UC-001/e2e-goal.md",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def write_use_case_e2e_contract(
    repo_root: Path,
    *,
    use_case: str = "Goal: Buyer reserves a seat.\nResult: Seat is held for payment.\n",
    e2e: str = "When the buyer reserves a seat\nThen the seat is held for payment.\n",
) -> None:
    use_case_dir = repo_root / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(f"# Use Case\n\n{use_case}", encoding="utf-8")
    (use_case_dir / "e2e-goal.md").write_text(f"# E2E\n\n{e2e}", encoding="utf-8")


def agent_request(tmp_path: Path, agent_config: dict) -> AgentRunRequest:
    return AgentRunRequest(
        step=Step(
            id="execute-work-item",
            kind=StepKind.AGENT,
            name="Execute plan",
            agent_id="implementation_executor",
            skill_id="harness-plan-executor",
            timeout_sec=30,
        ),
        context=context(tmp_path),
        step_dir=tmp_path / ".harness/runs/run-001/steps/execute-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_executor.toml",
        agent_config=agent_config,
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Harness Plan Executor\n스킬 본문",
    )


def test_basic_step_runner_invokes_agent_adapter_and_writes_result(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path)
    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text("# ChangeSet CHG-001\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.output_path == Path(
        ".harness/runs/run-001/steps/plan-work-item/result.json"
    )
    assert fake_adapter.requests[0].agent_config["name"] == "implementation_planner"

    result_json = json.loads((tmp_path / result.output_path).read_text(encoding="utf-8"))
    assert result_json["agent_id"] == "implementation_planner"
    assert result_json["status"] == "succeeded"
    assert result_json["metadata"] == {"fake": True}


def test_implementation_executor_scope_diff_allows_changeset_scope(
    tmp_path: Path,
) -> None:
    init_git_repo(tmp_path)
    write_executor_scope_fixture(tmp_path)
    runner = BasicStepRunner(
        agent_adapter=FileEditingAgentAdapter(
            {
                "docs/plans/active/UC-001/plan.md": "# updated plan\n",
                "src/main/java/com/example/ticketing/reservation/ReservationService.java": "class ReservationService {}\n",
            }
        )
    )

    result = runner.run(executor_step(), executor_context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["scope_diff_status"] == "passed"
    report = json.loads(
        (
            tmp_path
            / ".harness/runs/run-001/UC-001/steps/execute-work-item/scope-diff-report.json"
        ).read_text(encoding="utf-8")
    )
    assert report["blocked"] == []
    assert any(
        row["path"]
        == "src/main/java/com/example/ticketing/reservation/ReservationService.java"
        for row in report["allowed"]
    )


def test_implementation_executor_scope_diff_blocks_unexpected_file(
    tmp_path: Path,
) -> None:
    init_git_repo(tmp_path)
    write_executor_scope_fixture(tmp_path)
    runner = BasicStepRunner(
        agent_adapter=FileEditingAgentAdapter(
            {
                "docs/plans/active/UC-001/plan.md": "# updated plan\n",
                "build.gradle": "plugins {}\n",
                "src/main/java/com/example/ticketing/payment/PaymentService.java": "class PaymentService {}\n",
            }
        )
    )

    result = runner.run(executor_step(), executor_context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert "build.gradle" in (result.error or "")
    assert "PaymentService.java" in (result.error or "")
    result_json = json.loads((tmp_path / result.output_path).read_text(encoding="utf-8"))
    assert result_json["status"] == "blocked"
    assert "build.gradle" in result_json["metadata"]["scope_diff_blocked_files"]
    blocked_paths = {
        row["path"]
        for row in json.loads(
            (
                tmp_path
                / ".harness/runs/run-001/UC-001/steps/execute-work-item/scope-diff-report.json"
            ).read_text(encoding="utf-8")
        )["blocked"]
    }
    assert "build.gradle" in blocked_paths
    assert "src/main/java/com/example/ticketing/payment/PaymentService.java" in blocked_paths


def test_declared_output_agent_allows_runtime_generated_artifacts(
    tmp_path: Path,
) -> None:
    init_git_repo(tmp_path)
    write_agent_config(tmp_path, "implementation_planner")
    runner = BasicStepRunner(
        agent_adapter=FileEditingAgentAdapter(
            {
                "docs/plans/active/UC-001/plan.md": "# plan\n",
                ".harness/logs/ui-server.log": "server log\n",
                ".harness/contracts/CHG-001/UC-001/plan.contract.json": "{}\n",
                "app/build/reports/tests/index.html": "<html></html>\n",
                ".codex/agents/implementation_executor.toml": "name = \"implementation_executor\"\n",
            }
        )
    )
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["scope_diff_status"] == "passed"
    report = json.loads(
        (
            tmp_path
            / ".harness/runs/run-001/steps/plan-work-item/scope-diff-report.json"
        ).read_text(encoding="utf-8")
    )
    assert report["blocked"] == []


def test_basic_step_runner_appends_runtime_remediation_task(tmp_path: Path) -> None:
    plan_path = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# Plan\n\n- [x] Existing task\n", encoding="utf-8")
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    run_context = RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-001",
        metadata={
            "runtime_retry_count": "1",
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": "implementation",
            "runtime_failure_error": "missing branch\nextra details",
        },
    )
    step = Step(
        id="remediate-work-item",
        kind=StepKind.RECORD,
        name="Remediate",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={"loop_target": "execute-work-item"},
    )

    result = runner.run(step, run_context)

    assert result.status == StepStatus.SUCCEEDED
    plan_text = plan_path.read_text(encoding="utf-8")
    assert "## Runtime Remediation" in plan_text
    assert "- [ ] Retry 1: fix `verify-work-item` (implementation)" in plan_text
    assert "missing branch" in plan_text
    assert "extra details" not in plan_text


def test_basic_step_runner_classifies_implementation_failure(tmp_path: Path) -> None:
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    run_context = RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": "implementation",
            "runtime_failure_error": "assertion failed",
        },
    )
    step = Step(
        id="classify-verification-result",
        kind=StepKind.DECISION,
        name="Classify",
        metadata={
            "classifier": "verification_result",
            "on_implementation_failure": "remediate-work-item",
        },
    )

    result = runner.run(step, run_context)

    assert result.status == StepStatus.SUCCEEDED
    assert result.failure_kind is None
    assert result.metadata["decision"]["decision"] == "IMPLEMENTATION_FAILURE"
    assert result.metadata["decision"]["route"] == "remediate-work-item"
    assert result.metadata["decision"]["blocked"] is False
    evidence = tmp_path / result.output_path
    assert json.loads(evidence.read_text(encoding="utf-8"))["work_item_id"] == "UC-001"


def test_basic_step_runner_blocks_unclear_e2e_goal_decision(tmp_path: Path) -> None:
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    run_context = RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-001",
        metadata={
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": "unknown",
            "runtime_failure_error": "ambiguous E2E goal",
        },
    )
    step = Step(
        id="classify-verification-result",
        kind=StepKind.DECISION,
        name="Classify",
        metadata={
            "classifier": "verification_result",
            "on_unclear_e2e_goal": "e2e-goal-approval",
        },
    )

    result = runner.run(step, run_context)

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.UNCLEAR_E2E_GOAL
    assert result.metadata["decision"]["decision"] == "UNCLEAR_E2E_GOAL"
    assert result.metadata["decision"]["owner_stage"] == "e2e-goal-approval"
    assert "return to E2E goal approval gate" in result.error


def test_basic_step_runner_blocks_unsupported_decision_step(tmp_path: Path) -> None:
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="pick-next-thing",
        kind=StepKind.DECISION,
        name="Unsupported decision",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.error == "decision classifier is required"
    assert result.metadata["decision"]["decision"] == "UNSUPPORTED_DECISION_STEP"


def test_basic_step_runner_records_skill_invocation_manifest(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    write_skill(tmp_path)
    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text("# ChangeSet CHG-001\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    request = fake_adapter.requests[0]
    assert request.skill_path == (
        tmp_path / ".codex/skills/harness-code-planner/SKILL.md"
    )
    assert request.skill_body is None

    invocation = json.loads(
        (
            tmp_path / ".harness/runs/run-001/steps/plan-work-item/invocation.json"
        ).read_text(encoding="utf-8")
    )
    assert invocation["agent_id"] == "implementation_planner"
    assert invocation["skill_id"] == "harness-code-planner"
    assert invocation["skill_path"] == ".codex/skills/harness-code-planner/SKILL.md"
    assert invocation["outputs"] == ["docs/plans/active/UC-001/plan.md"]


def test_basic_step_runner_blocks_agent_without_config(tmp_path: Path) -> None:
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "missing agent config" in (result.error or "")
    assert result.output_path == Path(
        ".harness/runs/run-001/steps/plan-work-item/result.json"
    )


def test_basic_step_runner_blocks_agent_without_skill(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "missing skill config" in (result.error or "")


def test_basic_step_runner_fails_when_agent_output_is_missing(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter(write_outputs=False))
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.FAILED
    assert result.error == "missing agent outputs: docs/plans/active/UC-001/plan.md"


def test_basic_step_runner_blocks_rejected_review_gate(tmp_path: Path) -> None:
    write_agent_config(tmp_path, "artifact_reviewer")
    write_skill(tmp_path, "harness-artifact-reviewer")
    runner = BasicStepRunner(
        agent_adapter=ReviewAgentAdapter("Review Status: rejected\n\nBlocking Findings\n")
    )
    step = Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="Review plan",
        agent_id="artifact_reviewer",
        skill_id="harness-artifact-reviewer",
        outputs=(
            Path(".harness/runs/run-001/work-items/UC-001/reviews/plan-review.md"),
        ),
        metadata={
            "review_gate": {
                "output": ".harness/runs/run-001/work-items/UC-001/reviews/plan-review.md",
                "status_label": "Review Status",
                "approved_status": "approved",
            }
        },
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.PLAN_REVIEW_REJECTED
    assert result.error == "review gate status is `rejected`, expected `approved`"
    assert result.metadata["review_gate_status"] == "blocked"


def test_plan_review_preflight_blocks_ui_dto_application_dependency(tmp_path: Path) -> None:
    write_agent_config(tmp_path, "artifact_reviewer")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    e2e = tmp_path / "docs/use-cases/UC-001/e2e-goal.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    e2e.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "",
                "## 패키지 및 의존성 계약",
                "- application은 `ui.dto`에 의존한다.",
                "",
                "## 집중 검증",
                "- [ ] VERIFY-001 `./gradlew test`",
            ]
        ),
        encoding="utf-8",
    )
    e2e.write_text("# E2E Goal\n", encoding="utf-8")
    adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=adapter)
    step = Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="Review plan",
        agent_id="artifact_reviewer",
        inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path("docs/use-cases/UC-001/e2e-goal.md"),
        ),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "plan review contract preflight failed" in (result.error or "")
    assert "ui.dto" in (result.error or "")
    assert adapter.requests == []


def test_plan_review_preflight_requires_e2e_or_maintenance_command(tmp_path: Path) -> None:
    write_agent_config(tmp_path, "artifact_reviewer")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    e2e = tmp_path / "docs/use-cases/UC-001/e2e-goal.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    e2e.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "",
                "## 패키지 및 의존성 계약",
                "- application은 domain에만 의존한다.",
                "",
                "## 집중 검증",
                "- [ ] VERIFY-001 `./gradlew test`",
            ]
        ),
        encoding="utf-8",
    )
    e2e.write_text("# E2E Goal\n", encoding="utf-8")
    adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=adapter)
    step = Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="Review plan",
        agent_id="artifact_reviewer",
        inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path("docs/use-cases/UC-001/e2e-goal.md"),
        ),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "E2E or maintenance verification command" in (result.error or "")
    assert adapter.requests == []


def test_plan_rerun_blocks_checked_checkbox_reset(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    write_skill(tmp_path)
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "",
                "## 작업 체크리스트",
                "",
                "- [x] TASK-001 완료",
                "- [ ] TASK-002 남음",
                "",
                "## 집중 검증",
                "",
                "- [ ] VERIFY-001 test",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    edited = plan.read_text(encoding="utf-8").replace("- [x] TASK-001", "- [ ] TASK-001")
    runner = BasicStepRunner(
        agent_adapter=FileEditingAgentAdapter(
            {"docs/plans/active/UC-001/plan.md": edited}
        )
    )
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )
    retry_context = replace(
        context(tmp_path),
        metadata={
            **context(tmp_path).metadata,
            "active_work_item_id": "UC-001",
            "runtime_retry_count": 1,
            "runtime_failed_step_id": "review-work-item-plan",
            "runtime_failure_kind": "plan_review_rejected",
            "runtime_failure_error": "review rejected",
        },
    )

    result = runner.run(step, retry_context)

    assert result.status == StepStatus.BLOCKED
    assert result.metadata["plan_mutation_guard_status"] == "blocked"
    assert result.failure_kind == FailureKind.ENVIRONMENT_BLOCKER
    assert "checked checklist items were reset" in result.error
    assert (
        tmp_path
        / ".harness/runs/run-001/work-items/UC-001/plan-mutation-request.json"
    ).is_file()


def test_plan_rerun_passes_small_allowed_patch(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    write_skill(tmp_path)
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "",
                "## 집중 검증",
                "",
                "- [ ] VERIFY-001 old command",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    edited = plan.read_text(encoding="utf-8").replace("old command", "new command")
    adapter = FileEditingAgentAdapter({"docs/plans/active/UC-001/plan.md": edited})
    runner = BasicStepRunner(agent_adapter=adapter)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )
    retry_context = replace(
        context(tmp_path),
        metadata={
            **context(tmp_path).metadata,
            "active_work_item_id": "UC-001",
            "runtime_retry_count": 1,
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": "implementation",
            "runtime_failure_error": "missing command evidence",
        },
    )

    result = runner.run(step, retry_context)

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["plan_mutation_guard_status"] == "passed"
    assert "plan-mutation-request.json" in adapter.requests[0].prompt_suffix


def test_basic_step_runner_fails_when_required_use_case_slices_are_missing(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    adapter = FakeAgentAdapter(write_outputs=True)
    runner = BasicStepRunner(agent_adapter=adapter)
    step = Step(
        id="harvest-use-cases",
        kind=StepKind.AGENT,
        name="Derive use cases",
        agent_id="implementation_planner",
        outputs=(Path("docs/design/유스케이스.md"), Path("docs/use-cases")),
        metadata={
            "slice_outputs": {
                "root": "docs/use-cases",
                "required_per_use_case": ("use-case.md", "e2e-goal.md"),
            }
        },
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.FAILED
    assert result.error == "missing required use-case slices under docs/use-cases"


def test_basic_step_runner_blocks_planner_when_use_case_e2e_contract_fails(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path)
    write_use_case_e2e_contract(
        tmp_path,
        use_case="Goal: Buyer reserves a seat.\nResult: Seat is held for payment.\n",
        e2e="When the buyer purchases a ticket\nThen the ticket is issued immediately.\n",
    )
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="planner-create-use-case-plan",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={"stage": "planner", "scope": "use_case"},
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert fake_adapter.requests == []
    assert "use_case_e2e_alignment failed between" in (result.error or "")
    assert "docs/use-cases/UC-001/use-case.md" in (result.error or "")
    assert "docs/use-cases/UC-001/e2e-goal.md" in (result.error or "")


def test_basic_step_runner_blocks_plan_completion_with_unchecked_checkbox(
    tmp_path: Path,
) -> None:
    write_completed_plan(tmp_path, unchecked=True)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "unchecked checkbox remains" in (result.error or "")
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").exists()


def test_basic_step_runner_blocks_plan_completion_with_empty_result(tmp_path: Path) -> None:
    write_completed_plan(tmp_path, empty_result="Tests")
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.error == "plan completion blocked: empty verification result: Tests"
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").exists()


def test_basic_step_runner_blocks_plan_completion_with_missing_evidence(
    tmp_path: Path,
) -> None:
    write_completed_plan(tmp_path, missing_evidence=True)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "missing evidence artifact" in (result.error or "")
    assert ".harness/runs/run-001/steps/final-verification/static-analysis.txt" in (
        result.error or ""
    )
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").exists()


def test_basic_step_runner_blocks_plan_completion_when_decision_lacks_plan_coverage(
    tmp_path: Path,
) -> None:
    write_completed_plan(tmp_path)
    decisions_path = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    decisions_path.write_text(
        "# Technical Decisions\n\n"
        "Approved decision: Duplicate payment requests must use idempotency keys.\n",
        encoding="utf-8",
    )
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "technical_decision_plan_coverage failed between" in (result.error or "")
    assert "docs/use-cases/UC-001/technical-decisions.md" in (result.error or "")
    assert "docs/plans/active/UC-001/plan.md" in (result.error or "")
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").exists()


def test_basic_step_runner_moves_completed_plan_after_completion_validation(
    tmp_path: Path,
) -> None:
    write_completed_plan(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert not (tmp_path / "docs/plans/active/UC-001/plan.md").exists()
    assert (tmp_path / "docs/plans/completed/UC-001/plan.md").exists()


def test_basic_step_runner_completes_plan_with_focused_verification_template(
    tmp_path: Path,
) -> None:
    plan_path = write_completed_plan(tmp_path)
    text = plan_path.read_text(encoding="utf-8")
    plan_path.write_text(
        text.replace("## 8. 검증 방법", "## 집중 검증").replace("- Tests:", "- Focused tests:"),
        encoding="utf-8",
    )
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert not (tmp_path / "docs/plans/active/UC-001/plan.md").exists()
    assert (tmp_path / "docs/plans/completed/UC-001/plan.md").exists()


def test_basic_step_runner_falls_back_to_standard_evidence_paths(
    tmp_path: Path,
) -> None:
    plan_path = write_completed_plan(tmp_path)
    text = plan_path.read_text(encoding="utf-8")
    for evidence in (
        ".harness/runs/run-001/steps/final-verification/build.txt",
        ".harness/runs/run-001/steps/final-verification/tests.txt",
        ".harness/runs/run-001/steps/final-verification/e2e.txt",
        ".harness/runs/run-001/steps/final-verification/test-gate.txt",
        ".harness/runs/run-001/steps/final-verification/runtime.txt",
        ".harness/runs/run-001/steps/final-verification/static-analysis.txt",
    ):
        text = text.replace(f" `{evidence}`", "")
    text = text.replace("## 8. 검증 방법", "## 집중 검증")
    text = text.replace("- Tests:", "- Focused tests:")
    text = text.replace(
        "- E2E 또는 maintenance verification: PASS",
        "- Architecture test: N/A for local boundary.\n"
        "- E2E 또는 maintenance verification: PASS",
    )
    plan_path.write_text(text, encoding="utf-8")
    evidence_dir = (
        tmp_path
        / ".harness/runs/run-002/work-items/UC-001/steps/execute-work-item/evidence"
    )
    evidence_dir.mkdir(parents=True, exist_ok=True)
    for name in ("build.txt", "tests.txt", "e2e.txt", "test-gate.txt", "runtime.txt", "static-analysis.txt"):
        (evidence_dir / name).write_text("PASS\n", encoding="utf-8")
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-use-case-plan",
        kind=StepKind.GIT,
        name="Complete plan",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert (tmp_path / "docs/plans/completed/UC-001/plan.md").exists()


def test_basic_step_runner_completes_changeset_with_completion_report(
    tmp_path: Path,
) -> None:
    write_changeset_ready_for_completion(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-change-set",
        kind=StepKind.GIT,
        name="Complete ChangeSet",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/changes/completed/CHG-001.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.output_path == Path(
        ".harness/runs/run-001/changeset-completion-report.md"
    )
    assert result.metadata["completed_path"] == "docs/changes/completed/CHG-001.md"
    assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()
    assert (tmp_path / "docs/changes/completed/CHG-001.md").exists()
    assert (tmp_path / result.output_path).is_file()


def test_basic_step_runner_blocks_changeset_completion_with_active_plan(
    tmp_path: Path,
) -> None:
    write_changeset_ready_for_completion(tmp_path, active_plan=True)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="complete-change-set",
        kind=StepKind.GIT,
        name="Complete ChangeSet",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/changes/completed/CHG-001.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "active work item plans still exist" in (result.error or "")
    assert (tmp_path / "docs/changes/active/CHG-001.md").exists()
    assert not (tmp_path / "docs/changes/completed/CHG-001.md").exists()


def test_basic_step_runner_blocks_pr_creation_without_gh(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(runner_module.shutil, "which", lambda _name: None)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="create-change-set-pr",
        kind=StepKind.GIT,
        name="Create ChangeSet PR",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "GitHub CLI `gh` is required" in (result.error or "")


def test_basic_step_runner_reuses_existing_changeset_pr(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_run(args, **_kwargs):
        calls.append(tuple(args))
        if args[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
            return subprocess.CompletedProcess(args, 0, stdout="true\n", stderr="")
        if args[:3] == ["git", "branch", "--show-current"]:
            return subprocess.CompletedProcess(args, 0, stdout="feature/chg-001\n", stderr="")
        if args[:3] == ["git", "remote", "get-url"]:
            return subprocess.CompletedProcess(args, 0, stdout="git@github.com:org/repo.git\n", stderr="")
        if args[:3] == ["git", "status", "--porcelain"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[:4] == ["git", "push", "-u", "origin"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout='{"url":"https://github.com/org/repo/pull/12"}\n',
                stderr="",
            )
        return subprocess.CompletedProcess(args, 1, stdout="", stderr="unexpected")

    monkeypatch.setattr(runner_module.shutil, "which", lambda _name: "/usr/bin/gh")
    monkeypatch.setattr(runner_module.subprocess, "run", fake_run)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="create-change-set-pr",
        kind=StepKind.GIT,
        name="Create ChangeSet PR",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["pull_request_url"] == "https://github.com/org/repo/pull/12"
    assert result.metadata["already_exists"] is True
    assert ("git", "push", "-u", "origin", "HEAD") in calls


def test_basic_step_runner_commits_pushes_and_creates_changeset_pr(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_run(args, **_kwargs):
        calls.append(tuple(args))
        if args[:3] == ["git", "rev-parse", "--is-inside-work-tree"]:
            return subprocess.CompletedProcess(args, 0, stdout="true\n", stderr="")
        if args[:3] == ["git", "branch", "--show-current"]:
            return subprocess.CompletedProcess(args, 0, stdout="feature/chg-001\n", stderr="")
        if args[:3] == ["git", "remote", "get-url"]:
            return subprocess.CompletedProcess(args, 0, stdout="git@github.com:org/repo.git\n", stderr="")
        if args[:3] == ["git", "status", "--porcelain"]:
            return subprocess.CompletedProcess(args, 0, stdout=" M docs/file.md\n", stderr="")
        if args[:3] == ["git", "add", "-A"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[:3] == ["git", "diff", "--cached"]:
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="")
        if args[:3] == ["git", "commit", "-m"]:
            return subprocess.CompletedProcess(args, 0, stdout="[feature abc] done\n", stderr="")
        if args[:4] == ["git", "push", "-u", "origin"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="no pull requests")
        if args[:3] == ["gh", "pr", "create"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="https://github.com/org/repo/pull/13\n",
                stderr="",
            )
        return subprocess.CompletedProcess(args, 1, stdout="", stderr="unexpected")

    monkeypatch.setattr(runner_module.shutil, "which", lambda _name: "/usr/bin/gh")
    monkeypatch.setattr(runner_module.subprocess, "run", fake_run)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="create-change-set-pr",
        kind=StepKind.GIT,
        name="Create ChangeSet PR",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["pull_request_url"] == "https://github.com/org/repo/pull/13"
    assert result.metadata["already_exists"] is False
    assert ("git", "add", "-A") in calls
    assert ("git", "push", "-u", "origin", "HEAD") in calls
    assert any(call[:3] == ("gh", "pr", "create") for call in calls)


def test_basic_step_runner_blocks_implementation_executor_on_gradle_workspace_sandbox(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    (tmp_path / "gradlew").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "implementation environment preflight failed" in (result.error or "")
    assert "sandbox_mode is workspace-write" in (result.error or "")
    assert fake_adapter.requests == []
    preflight = json.loads(
        (tmp_path / ".harness/runs/run-001/steps/execute-work-item/preflight.json").read_text(
            encoding="utf-8"
        )
    )
    assert preflight["status"] == "blocked"
    assert preflight["gradlew_present"] is True


def test_basic_step_runner_rejects_executor_success_while_plan_remains_active(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    write_skill(tmp_path, skill_id="harness-plan-executor")
    active_plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    active_plan.parent.mkdir(parents=True)
    active_plan.write_text("# Implementation Plan\n\n- [ ] Remaining task\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    run_context = context(tmp_path)
    run_context = RunContext(
        **{
            **run_context.__dict__,
            "active_plan_path": Path("docs/plans/active/UC-001/plan.md"),
            "metadata": {
                **dict(run_context.metadata),
                "active_work_item_id": "UC-001",
                "uc_id": "UC-001",
            },
        }
    )
    step = Step(
        id="implementation",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
        skill_id="harness-plan-executor",
        outputs=(Path("docs/plans/completed/UC-001/plan.md"),),
    )

    result = runner.run(step, run_context)

    assert result.status == StepStatus.FAILED
    assert "implementation plan remains active" in (result.error or "")


def test_plan_completion_accepts_english_section_headings(tmp_path: Path) -> None:
    plan_path = write_completed_plan(tmp_path)
    text = plan_path.read_text(encoding="utf-8")
    plan_path.write_text(
        text.replace("## 8. 검증 방법", "## 8. Verification Method")
        .replace("## 9. 완료 조건", "## 9. Completion Policy")
        .replace("## 10. 검증 결과", "## 10. Verification Results"),
        encoding="utf-8",
    )

    validate_plan_completion(
        tmp_path,
        Path("docs/plans/active/UC-001/plan.md"),
        run_id="run-001",
        change_set_id="CHG-001",
        work_item_id="UC-001",
    )


def test_basic_step_runner_blocks_agent_with_missing_inputs_before_adapter(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="harness_usecases")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="harvest-use-cases",
        kind=StepKind.AGENT,
        name="Harvest use cases",
        agent_id="harness_usecases",
        inputs=(Path("docs/design/ubiquitous-language.md"), Path("docs/design/요구사항.md")),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "agent input preflight failed" in (result.error or "")
    assert "docs/design/ubiquitous-language.md" in (result.error or "")
    assert "docs/design/요구사항.md" in (result.error or "")
    assert fake_adapter.requests == []
    preflight = json.loads(
        (tmp_path / ".harness/runs/run-001/steps/harvest-use-cases/input-preflight.json").read_text(
            encoding="utf-8"
        )
    )
    assert preflight["status"] == "blocked"
    assert preflight["missing_inputs"] == [
        "docs/design/ubiquitous-language.md",
        "docs/design/요구사항.md",
    ]


def test_basic_step_runner_validates_only_target_use_case_slice(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="harness_usecases")
    (tmp_path / "docs/use-cases/UC-002").mkdir(parents=True)
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="use-case-definition",
        kind=StepKind.AGENT,
        name="Use Case Definition",
        agent_id="harness_usecases",
        outputs=(
            Path("docs/design/유스케이스.md"),
            Path("docs/use-cases/UC-001/use-case.md"),
            Path("docs/use-cases/UC-001/e2e-goal.md"),
        ),
        metadata={
            "target_uc": "UC-001",
            "slice_outputs": {
                "root": "docs/use-cases",
                "required_per_use_case": ["use-case.md", "e2e-goal.md"],
            },
        },
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert len(fake_adapter.requests) == 1


def test_basic_step_runner_allows_implementation_executor_with_full_access(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    config_path = tmp_path / ".codex/agents/implementation_executor.toml"
    config_path.write_text(
        config_path.read_text(encoding="utf-8").replace(
            'sandbox_mode = "workspace-write"',
            'sandbox_mode = "danger-full-access"',
        ),
        encoding="utf-8",
    )
    (tmp_path / "gradlew").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert len(fake_adapter.requests) == 1
    preflight = json.loads(
        (tmp_path / ".harness/runs/run-001/steps/execute-work-item/preflight.json").read_text(
            encoding="utf-8"
        )
    )
    assert preflight["status"] == "passed"


def test_configurable_agent_adapter_uses_codex_provider_by_default(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "model": "gpt-5.4",
            "model_reasoning_effort": "medium",
            "sandbox_mode": "workspace-write",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        kwargs["stdout"].write("live agent stdout")
        kwargs["stdout"].flush()
        kwargs["stderr"].write("live agent stderr")
        kwargs["stderr"].flush()
        assert (request.step_dir / "stdout.txt").read_text(encoding="utf-8") == "live agent stdout"
        assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == "live agent stderr"
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="agent stdout",
            stderr="agent stderr",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["provider"] == "codex"
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-test", "exec", "--skip-git-repo-check"]
    assert "--ask-for-approval" not in command
    assert 'approval_policy="never"' in command
    assert "--output-last-message" in command
    assert "--json" in command
    assert "--model" in command
    assert (request.step_dir / "stdout.txt").read_text(encoding="utf-8") == (
        "agent stdout"
    )
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == (
        "agent stderr"
    )
    prompt = (request.step_dir / "prompt.md").read_text(encoding="utf-8")
    assert "implementation_executor" in prompt
    assert "harness-plan-executor" in prompt
    assert "스킬 본문" not in prompt
    assert "테스트 지시문" not in prompt
    assert calls[-1][1]["timeout"] == 30
    assert "capture_output" not in calls[-1][1]


def test_configurable_agent_adapter_handles_missing_stream_artifacts(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "model": "gpt-5.4",
            "model_reasoning_effort": "medium",
            "sandbox_mode": "workspace-write",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        Path(kwargs["stdout"].name).unlink()
        Path(kwargs["stderr"].name).unlink()
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout=None,
            stderr=None,
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.FAILED
    assert (request.step_dir / "stdout.txt").read_text(encoding="utf-8") == ""
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == ""


def test_configurable_agent_adapter_appends_prompt_suffix(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
        },
    )
    request = AgentRunRequest(
        step=request.step,
        context=request.context,
        step_dir=request.step_dir,
        agent_config_path=request.agent_config_path,
        agent_config=request.agent_config,
        skill_path=request.skill_path,
        prompt_suffix="Return only JSON with keys: status, changed_files.",
    )
    request.step_dir.mkdir(parents=True)
    captured = {}

    def fake_run(*args, **kwargs):
        captured["input"] = kwargs["input"]
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    prompt = (request.step_dir / "prompt.md").read_text(encoding="utf-8")
    assert result.status == StepStatus.SUCCEEDED
    assert prompt.endswith("Return only JSON with keys: status, changed_files.\n")
    assert captured["input"] == prompt


def test_configurable_agent_adapter_trims_large_successful_stderr(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)
    stderr = "start\n" + ("x" * 30_000) + "\nend"

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="agent stdout",
            stderr=stderr,
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    stored = (request.step_dir / "stderr.txt").read_text(encoding="utf-8")
    assert result.status == StepStatus.SUCCEEDED
    assert "successful agent stderr truncated" in stored
    assert "original_bytes=" in stored
    assert "retained_tail_bytes=16384" in stored
    assert "end" in stored
    assert "start" not in stored
    assert len(stored.encode("utf-8")) < len(stderr.encode("utf-8"))


def test_configurable_agent_adapter_keeps_large_failed_stderr(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)
    stderr = "start\n" + ("x" * 30_000) + "\nend"

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr=stderr,
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    stored = (request.step_dir / "stderr.txt").read_text(encoding="utf-8")
    assert result.status == StepStatus.FAILED
    assert stored == stderr


def test_configurable_agent_adapter_resumes_compatible_timed_out_implementation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_id = "019eb4b0-1111-7222-8333-444455556666"
    first = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "sandbox_mode": "danger-full-access",
        },
    )
    first.step_dir.mkdir(parents=True)
    calls: list[list[str]] = []

    def timeout_run(command: list[str], **kwargs: object):
        calls.append(command)
        raise subprocess.TimeoutExpired(
            command,
            timeout=30,
            output=(
                f'{{"type":"thread.started","thread_id":"{session_id}"}}\n'
                '{"type":"item.completed","item":{"type":"command_execution",'
                '"command":"python3 -m pytest tests/unit","exit_code":0}}\n'
            ),
        )

    monkeypatch.setattr(subprocess, "run", timeout_run)

    timed_out = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(first)

    assert timed_out.status == StepStatus.FAILED
    attempt = json.loads((first.step_dir / "attempt.json").read_text(encoding="utf-8"))
    checkpoint = json.loads(
        (first.step_dir / "checkpoint.json").read_text(encoding="utf-8")
    )
    assert attempt["provider_session_id"] == session_id
    assert attempt["termination_reason"] == "timeout"
    assert checkpoint["completed_tasks"] == ["implementation", "focused-tests"]
    assert checkpoint["next_phase"] == "build"
    assert checkpoint["phase_metrics"]["focused-tests"]["command_count"] == 1
    assert timed_out.metadata["phase_metrics"]["focused-tests"]["command_count"] == 1

    second_context = replace(
        first.context,
        run_id="run-002",
        run_dir=tmp_path / ".harness/runs/run-002",
    )
    second = replace(
        first,
        context=second_context,
        step_dir=second_context.run_dir / "steps/execute-work-item",
    )

    def success_run(command: list[str], **kwargs: object):
        calls.append(command)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=f'{{"type":"thread.started","thread_id":"{session_id}"}}\n',
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", success_run)

    resumed = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(second)

    assert resumed.status == StepStatus.SUCCEEDED
    assert resumed.metadata["execution_mode"] == "resumed"
    assert resumed.metadata["attempt"] == 2
    assert resumed.metadata["provider_session_id"] == session_id
    assert "phase_metrics" in resumed.metadata
    command = json.loads((second.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:4] == ["codex-test", "exec", "resume", session_id]
    assert "Durable implementation checkpoint" in (
        second.step_dir / "prompt.md"
    ).read_text(encoding="utf-8")


def test_configurable_agent_adapter_uses_explicit_codex_binary(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "codex",
            "provider_binary": "codex-explicit",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-default").run(request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-explicit", "exec", "--skip-git-repo-check"]


def test_configurable_agent_adapter_uses_custom_cli_provider(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "custom_cli",
            "provider_command": ["my-agent", "run", "--stdin"],
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="custom final message",
            stderr="custom stderr",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["provider"] == "custom_cli"
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command == ["my-agent", "run", "--stdin"]
    assert "--model" not in command
    assert "--skip-git-repo-check" not in command
    assert calls[0][1]["input"] == (request.step_dir / "prompt.md").read_text(
        encoding="utf-8"
    )
    assert (request.step_dir / "final-message.md").read_text(encoding="utf-8") == (
        "custom final message"
    )


def test_configurable_agent_adapter_blocks_custom_cli_without_command(
    tmp_path: Path,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "custom_cli",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.BLOCKED
    assert "provider_command" in (result.error or "")
    assert result.metadata["provider"] == "custom_cli"


def test_configurable_agent_adapter_blocks_unknown_provider(
    tmp_path: Path,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "other",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == "unsupported agent provider: other"
    assert result.metadata["provider"] == "other"


def test_codex_cli_agent_adapter_keeps_backward_compatible_name(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-test", "exec", "--skip-git-repo-check"]


def test_configurable_agent_adapter_blocks_when_provider_binary_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        raise FileNotFoundError("missing")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="missing-codex").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == (
        "agent provider binary not found: provider=codex binary=missing-codex"
    )
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == (
        "agent provider binary not found: provider=codex binary=missing-codex"
    )


def test_configurable_agent_adapter_blocks_on_usage_limit(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr="ERROR: You've hit your usage limit. Try again later.",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.exit_code == 1
    assert "usage limit" in (result.error or "")


def test_configurable_agent_adapter_reports_usage_limit_before_warnings(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr=(
                "WARN plugin sync failed\n"
                "ERROR: You've hit your usage limit. Try again later.\n"
            ),
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == "ERROR: You've hit your usage limit. Try again later."
