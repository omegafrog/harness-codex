from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"expected source fragment not found: {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_between(path: Path, start: str, end: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    path.write_text(text[:start_index] + replacement + text[end_index:], encoding="utf-8")


def workflow_steps(document: dict) -> list[dict]:
    return document["steps"]


def step_by_id(steps: list[dict], step_id: str) -> dict:
    return next(step for step in steps if step["id"] == step_id)


def patch_workflow() -> None:
    path = ROOT / ".harness/workflows/changeset-use-case-workflow.yaml"
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    document["workflow"]["description"] = (
        "Canonical ChangeSet workflow with typed work-item contracts, post-implementation "
        "security verification, and delivery gates."
    )
    steps = workflow_steps(document)

    verification = step_by_id(steps, "verify-work-item")
    verification["name"] = "Verify work item against its type-specific verification goal"

    security_verification = {
        "id": "verify-work-item-security",
        "kind": "agent",
        "name": "Independently review the implemented work item for security findings",
        "needs": ["verify-work-item"],
        "agent_id": "security_implementation_reviewer",
        "skill_id": "harness-security-implementation-reviewer",
        "inputs": [
            "docs/changes/active/<CHG-ID>.md",
            "docs/plans/active/<WORK-ITEM-ID>/plan.md",
            ".codex/repository-settings.md",
            ".codex/security/owasp-standards.json",
            ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/verification/report.json",
            ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/verification/verification.md",
        ],
        "outputs": [
            ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review.md",
        ],
        "metadata": {
            "stage": "security-verification",
            "scope": "work_item",
            "baseline": "OWASP ASVS 5.0.0",
            "inputs_resolved_by": "work_item_document_contract",
            "review_gate": {
                "output": ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review.md",
                "status_label": "Security Review Status",
                "approved_status": "approved",
            },
        },
    }
    if not any(step["id"] == security_verification["id"] for step in steps):
        insert_at = next(index for index, step in enumerate(steps) if step["id"] == "classify-verification-result")
        steps.insert(insert_at, security_verification)

    classify = step_by_id(steps, "classify-verification-result")
    classify["needs"] = ["verify-work-item-security"]
    classify["name"] = "Classify verification or security result for remediation or completion"

    wiki = step_by_id(steps, "update-project-wiki")
    wiki.setdefault("metadata", {})["run_on_final_work_item_only"] = True
    wiki["metadata"]["fail_closed"] = True
    wiki_build = step_by_id(steps, "validate-project-wiki")
    wiki_build.setdefault("metadata", {})["run_on_final_work_item_only"] = True
    wiki_build["metadata"]["fail_closed"] = True

    pr = step_by_id(steps, "create-change-set-pr")
    pr["name"] = "Commit, push, and create or reuse the ChangeSet pull request"
    pr["needs"] = ["validate-project-wiki"]
    pr.setdefault("metadata", {})["run_on_final_work_item_only"] = True
    pr["metadata"]["condition"] = "verified_changeset_output_committed_and_pushed"
    pr["metadata"]["fail_closed"] = True

    complete = step_by_id(steps, "complete-change-set")
    complete["name"] = "Complete active ChangeSet only after wiki and PR delivery gates succeed"
    complete["needs"] = ["create-change-set-pr"]
    complete.setdefault("metadata", {})["run_on_final_work_item_only"] = True
    complete["metadata"]["fail_closed"] = True

    delivery_ids = {
        "complete-work-item-plan",
        "update-project-wiki",
        "validate-project-wiki",
        "create-change-set-pr",
        "complete-change-set",
    }
    head = [step for step in steps if step["id"] not in delivery_ids]
    tail = [
        step_by_id(steps, "complete-work-item-plan"),
        wiki,
        wiki_build,
        pr,
        complete,
    ]
    document["steps"] = head + tail
    path.write_text(yaml.safe_dump(document, sort_keys=False, allow_unicode=True), encoding="utf-8")


def patch_materializer() -> None:
    path = ROOT / "harness_codex/runtime/workflows/materializer.py"
    replace_once(
        path,
        '''    elif stage in {"execution", "verification"}:
        contract_inputs = scope.executor_inputs
''',
        '''    elif stage in {"execution", "verification", "security-verification"}:
        contract_inputs = scope.executor_inputs
''',
    )


def patch_engine() -> None:
    path = ROOT / "harness_codex/runtime/engine.py"
    replace_once(
        path,
        '''            if self._is_runtime_remediation_step(step):
                continue

            decision = self._evaluate_command_policy(step, active_context)
''',
        '''            if self._is_runtime_remediation_step(step):
                continue

            if self._should_skip_precompleted_work_item_step(step, active_context):
                results.append(
                    StepResult(
                        step_id=step.id,
                        status=StepStatus.SKIPPED,
                        metadata={
                            "reason": "work item was completed before this run",
                            "precompleted_work_item": True,
                        },
                    )
                )
                continue

            decision = self._evaluate_command_policy(step, active_context)
''',
    )
    replace_once(
        path,
        "    def _evaluate_command_policy(\n",
        '''    def _should_skip_precompleted_work_item_step(
        self,
        step: Step,
        context: RunContext,
    ) -> bool:
        return bool(
            context.metadata.get("skip_precompleted_work_item_steps")
            and step.metadata.get("scope") == "work_item"
        )

    def _evaluate_command_policy(
''',
    )


def patch_cli() -> None:
    path = ROOT / "harness_codex/cli.py"
    replace_between(
        path,
        "    if _all_work_item_plans_completed(repo_root, scopes):\n",
        "    preflight_run_id = f\"run-{uuid4().hex[:12]}\"\n",
        '''    # Completed plans are not a completion shortcut. They re-enter this same
    # workflow with work-item nodes marked SKIPPED so final delivery gates still run.

''',
    )
    replace_once(
        path,
        "materialized_workflow = materialize_workflow_for_scope(workflow, change_set, scope)",
        "materialized_workflow = materialize_workflow_for_scope(\n            workflow, change_set, scope, run_id=run_id\n        )",
    )
    replace_once(
        path,
        '''                "is_final_work_item": scope_index == len(scopes) - 1,
                "affected_work_items": [
''',
        '''                "is_final_work_item": scope_index == len(scopes) - 1,
                "skip_precompleted_work_item_steps": _work_item_plan_completed(
                    repo_root,
                    scope,
                ),
                "affected_work_items": [
''',
    )
    replace_once(
        path,
        '''    execution = _implementation_execution_summary(result)
    return (
        f"APPLY started: run_id={state.run_id} status={result.status.value} "
        f"active_changeset_moved=false{execution}"
    )
''',
        '''    execution = _implementation_execution_summary(result)
    active_changeset_moved = (
        not (repo_root / "docs/changes/active" / f"{change_set.change_set_id}.md").exists()
        and (repo_root / "docs/changes/completed" / f"{change_set.change_set_id}.md").exists()
    )
    return (
        f"APPLY started: run_id={state.run_id} status={result.status.value} "
        f"active_changeset_moved={str(active_changeset_moved).lower()}{execution}"
    )
''',
    )
    replace_between(
        path,
        "def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:\n",
        "\n\ndef _complete_change_set_from_completed_plans(\n",
        '''def _work_item_plan_completed(repo_root: Path, scope) -> bool:
    return (
        (repo_root / _completed_plan_path(scope.display_id)).exists()
        and not (repo_root / _active_plan_path(scope)).exists()
    )


def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:
    return bool(scopes) and all(
        _work_item_plan_completed(repo_root, scope) for scope in scopes
    )
''',
    )
    text = path.read_text(encoding="utf-8")
    start = text.index("def _complete_change_set_from_completed_plans(\n")
    end = text.index("\n\ndef _active_plan_path(scope)", start)
    path.write_text(text[:start] + text[end:], encoding="utf-8")


def patch_state() -> None:
    path = ROOT / "harness_codex/runtime/state.py"
    replace_once(
        path,
        '''    REMEDIATE = "remediate"
    COMPLETE = "complete"
''',
        '''    REMEDIATE = "remediate"
    SECURITY = "security"
    DOCUMENTATION = "documentation"
    DELIVERY = "delivery"
    COMPLETE = "complete"
''',
    )
    replace_once(
        path,
        '''    WAIT_FOR_ENVIRONMENT = "WAIT_FOR_ENVIRONMENT"
    COMPLETE = "COMPLETE"
''',
        '''    WAIT_FOR_ENVIRONMENT = "WAIT_FOR_ENVIRONMENT"
    RETRY_FINALIZATION = "RETRY_FINALIZATION"
    COMPLETE = "COMPLETE"
''',
    )
    replace_once(
        path,
        '''    if state.status == RunStatus.SUCCEEDED:
        return ResumeTarget(
            disposition=ResumeDisposition.COMPLETE,
            reason="run already succeeded",
        )

''',
        '''    if state.status == RunStatus.SUCCEEDED:
        return ResumeTarget(
            disposition=ResumeDisposition.COMPLETE,
            reason="run already succeeded",
        )

    if state.failed_step_id == "verify-work-item-security":
        return ResumeTarget(
            disposition=ResumeDisposition.RETRY_REMEDIATION,
            uc_id=state.current_use_case_id,
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            step_id=UseCaseStep.SECURITY,
            reason="security review rejected the implemented work item",
        )

    if state.failed_step_id == "validate-project-wiki":
        return ResumeTarget(
            disposition=ResumeDisposition.RETRY_FINALIZATION,
            step_id=UseCaseStep.DOCUMENTATION,
            reason="strict wiki build must pass before ChangeSet completion",
        )

    if state.failed_step_id == "create-change-set-pr":
        return ResumeTarget(
            disposition=ResumeDisposition.RETRY_FINALIZATION,
            step_id=UseCaseStep.DELIVERY,
            reason="ChangeSet PR creation must succeed before ChangeSet completion",
        )

''',
    )


def patch_runner() -> None:
    path = ROOT / "harness_codex/runtime/runner.py"
    replace_once(
        path,
        '''    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        output_path=completion.report_path,
        metadata={
            "completed_path": str(completion.completed_path),
            "completed_work_items": list(completion.completed_work_items),
            "already_completed": completion.already_completed,
        },
    )


def _create_change_set_pull_request(
''',
        '''    delivery_error = _publish_change_set_completion(context, change_set.change_set_id)
    if delivery_error:
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            output_path=completion.report_path,
            error=f"ChangeSet completion delivery blocked: {delivery_error}",
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
        )

    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        output_path=completion.report_path,
        metadata={
            "completed_path": str(completion.completed_path),
            "completed_work_items": list(completion.completed_work_items),
            "already_completed": completion.already_completed,
            "completion_published": True,
        },
    )


def _publish_change_set_completion(context: RunContext, change_set_id: str) -> str | None:
    status = _run_git_command(context.repo_root, "status", "--porcelain")
    if status.returncode != 0:
        return status.stderr.strip() or status.stdout.strip()
    if status.stdout.strip():
        added = _run_git_command(context.repo_root, "add", "-A")
        if added.returncode != 0:
            return added.stderr.strip() or added.stdout.strip()
        staged = _run_git_command(context.repo_root, "diff", "--cached", "--quiet")
        if staged.returncode not in {0, 1}:
            return staged.stderr.strip() or staged.stdout.strip()
        if staged.returncode == 1:
            committed = _run_git_command(
                context.repo_root,
                "commit",
                "-m",
                f"{change_set_id} ChangeSet completion",
            )
            if committed.returncode != 0:
                return committed.stderr.strip() or committed.stdout.strip()
    pushed = _run_git_command(context.repo_root, "push", "origin", "HEAD")
    if pushed.returncode != 0:
        return pushed.stderr.strip() or pushed.stdout.strip()
    return None


def _create_change_set_pull_request(
''',
    )


def write_security_files() -> None:
    agent = ROOT / ".codex/agents/security_implementation_reviewer.toml"
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_text(
        '''name = "security_implementation_reviewer"
description = "Reviews implemented ChangeSet work-item code and evidence for applicable security findings."
sandbox_mode = "read-only"

[provider]
kind = "codex"
model = "gpt-5.5-thinking"
''',
        encoding="utf-8",
    )
    skill = ROOT / ".codex/skills/harness-security-implementation-reviewer/SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        '''---
name: harness-security-implementation-reviewer
description: Independently review one implemented ChangeSet work item after product verification and before completion. Inspect the implemented diff, active plan, verification evidence, and applicable OWASP controls. Use this as a blocking delivery gate.
---

# Harness Security Implementation Reviewer

## Scope

- Read only runtime-declared inputs and the repository diff relevant to the active work item.
- Do not edit implementation code, plans, ChangeSet documents, or upstream artifacts.
- Produce exactly one report at the runtime-declared output path.

## Review Flow

1. Derive the implemented attack surface from the active ChangeSet, work-item documents, active plan, verification evidence, and changed files.
2. Review applicable controls against the pinned OWASP sources in `.codex/security/`.
3. Check that security plan tasks are implemented and supported by focused evidence.
4. Write the report headings below.

## Report Contract

The first non-heading status line must be exactly one of:

- `Security Review Status: approved`
- `Security Review Status: rejected`

The report must contain:

- `## Reviewed Inputs`
- `## Security Findings`
- `## Remediation Target`
- `## Evidence`

For an approved review, `## Remediation Target` is `none`. A rejected review blocks delivery and must state whether the owner is `plan` or `implementation`.
''',
        encoding="utf-8",
    )


def write_tests() -> None:
    path = ROOT / "tests/test_issue_372_canonical_finalization.py"
    path.write_text(
        '''from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.state import (
    ResumeDisposition,
    RunState,
    UseCaseStep,
    decide_resume_target,
)
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
)


class RecordingRunner:
    def __init__(self) -> None:
        self.ran: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.ran.append(step.id)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_completed_work_item_uses_same_graph_and_runs_finalization(tmp_path: Path) -> None:
    workflow = Workflow(
        name="canonical",
        mode=RunMode.APPLY,
        steps=(
            Step("load", StepKind.RECORD, "load", metadata={"scope": "change_set"}),
            Step("plan", StepKind.AGENT, "plan", needs=("load",), metadata={"scope": "work_item"}),
            Step("execute", StepKind.AGENT, "execute", needs=("plan",), metadata={"scope": "work_item"}),
            Step("wiki", StepKind.AGENT, "wiki", needs=("execute",), metadata={"scope": "change_set"}),
            Step("pr", StepKind.GIT, "pr", needs=("wiki",), metadata={"scope": "change_set"}),
            Step("complete", StepKind.GIT, "complete", needs=("pr",), metadata={"scope": "change_set"}),
        ),
    )
    runner = RecordingRunner()
    result = RunnerEngine(runner).run(
        workflow,
        RunContext(
            run_id="run-372",
            workflow_name=workflow.name,
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/run-372",
            metadata={"skip_precompleted_work_item_steps": True},
        ),
    )

    assert result.status == RunStatus.SUCCEEDED
    assert runner.ran == ["load", "wiki", "pr", "complete"]
    assert [item.status for item in result.step_results][1:3] == [
        StepStatus.SKIPPED,
        StepStatus.SKIPPED,
    ]


def test_canonical_yaml_preserves_typed_contracts_and_delivery_order() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    ids = workflow.step_ids()
    security = workflow.step_by_id("verify-work-item-security")

    assert ids.index("verify-work-item") < ids.index("verify-work-item-security")
    assert ids.index("verify-work-item-security") < ids.index("complete-work-item-plan")
    assert ids.index("validate-project-wiki") < ids.index("create-change-set-pr")
    assert ids.index("create-change-set-pr") < ids.index("complete-change-set")
    assert security.metadata["inputs_resolved_by"] == "work_item_document_contract"


def test_security_verification_materializes_executor_contract_inputs() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    change_set = ChangeSet(change_set_id="CHG-372", title="test")
    use_case = AffectedUseCase(
        uc_id="UC-372",
        name="security test",
        impact_type="update",
        slice_path=Path("docs/use-cases/UC-372"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-372.md"),
        use_case=use_case,
        planner_inputs=(Path("docs/use-cases/UC-372/use-case.md"),),
        executor_inputs=(Path("docs/use-cases/UC-372/e2e-goal.md"),),
        e2e_goal_path=Path("docs/use-cases/UC-372/e2e-goal.md"),
        work_item_id="UC-372",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-372/plan.md"),
    )

    materialized = materialize_workflow_for_scope(
        workflow,
        change_set,
        scope,
        run_id="run-372",
    )
    security = materialized.step_by_id("verify-work-item-security")

    assert Path("docs/use-cases/UC-372/e2e-goal.md") in security.inputs
    assert all("<RUN-ID>" not in str(path) for path in security.inputs + security.outputs)


def test_finalization_failures_resume_at_finalization_not_work_item() -> None:
    wiki_state = RunState(
        run_id="run-wiki",
        change_set_id="CHG-372",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-372",),
        affected_work_items=("UC-372",),
        failed_step_id="validate-project-wiki",
        status=RunStatus.BLOCKED,
    )
    pr_state = RunState(
        run_id="run-pr",
        change_set_id="CHG-372",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-372",),
        affected_work_items=("UC-372",),
        failed_step_id="create-change-set-pr",
        status=RunStatus.BLOCKED,
    )

    assert decide_resume_target(wiki_state).disposition == ResumeDisposition.RETRY_FINALIZATION
    assert decide_resume_target(wiki_state).step_id == UseCaseStep.DOCUMENTATION
    assert decide_resume_target(pr_state).disposition == ResumeDisposition.RETRY_FINALIZATION
    assert decide_resume_target(pr_state).step_id == UseCaseStep.DELIVERY


def test_legacy_completed_plan_fast_path_is_removed() -> None:
    import harness_codex.cli as cli

    assert not hasattr(cli, "_complete_change_set_from_completed_plans")
''',
        encoding="utf-8",
    )


def main() -> None:
    patch_workflow()
    patch_materializer()
    patch_engine()
    patch_cli()
    patch_state()
    patch_runner()
    write_security_files()
    write_tests()


if __name__ == "__main__":
    main()
