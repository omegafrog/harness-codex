"""Agent-driven workflow orchestration boundary.

The workflow_orchestrator agent owns workflow progression. Python only creates a
session file and starts the top-level orchestrator agent. That agent then decides
which specialist step to execute next and calls the single-step runtime command
for each chosen step.
"""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import RunContext, RunResult, RunStatus, Step, StepKind, StepResult, StepStatus, Workflow
from harness_codex.runtime.orchestration_session import write_orchestration_session
from harness_codex.runtime.workflow_routing import WorkflowRoutingPolicy


class WorkflowOrchestrator:
    """Start the agent that owns workflow progression."""

    def __init__(
        self,
        *,
        engine: RunnerEngine,
        routing_policy: WorkflowRoutingPolicy | None = None,
        max_transitions: int = 64,
    ) -> None:
        self._engine = engine
        # Kept for constructor compatibility. Route choice belongs to the
        # workflow_orchestrator agent once the session starts.
        self._routing_policy = routing_policy
        self._max_transitions = max_transitions

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        """Run one top-level orchestration agent session.

        This method deliberately does not loop over workflow steps. The top-level
        workflow_orchestrator agent reads the session file, creates/runs each
        specialist step via `harness workflow-step run`, inspects the emitted
        StepResult JSON, and then either continues, repairs, verifies, completes,
        or pauses.
        """

        execution_plan = self._engine.plan(workflow)
        if not execution_plan.steps:
            return self._engine.run_result(
                workflow,
                context,
                (),
                status=RunStatus.SUCCEEDED,
                extra_metadata={"orchestrator_status": "empty_workflow"},
            )

        session_path = context.run_dir / "orchestration" / "session.json"
        write_orchestration_session(workflow, context, session_path)
        orchestrator_step = self._orchestration_agent_step(context, session_path)
        result = self._engine.execute_step(
            orchestrator_step,
            self._orchestrator_context(context, session_path),
            apply_work_item_skip=False,
        )
        status = _run_status_for_orchestrator_result(result)
        return self._engine.run_result(
            workflow,
            context,
            (result,),
            status=status,
            failed_step_id=result.step_id if status is not RunStatus.SUCCEEDED else None,
            failure_kind=result.failure_kind,
            blocker=result.error,
            extra_metadata={
                "progress_owner": "workflow_orchestrator_agent",
                "engine_role": "single_step_executor",
                "orchestration_session_path": str(session_path.relative_to(context.repo_root)),
                "orchestrator_status": result.status.value,
            },
        )

    def _orchestration_agent_step(self, context: RunContext, session_path: Path) -> Step:
        summary_path = context.run_dir / "orchestration" / "orchestration-summary.md"
        return Step(
            id="workflow-orchestrator",
            kind=StepKind.AGENT,
            name="Run workflow orchestration session",
            agent_id="workflow_orchestrator",
            skill_id="harness-workflow-orchestrator",
            inputs=(session_path.relative_to(context.repo_root),),
            outputs=(summary_path.relative_to(context.repo_root),),
            metadata={
                "stage": "orchestration",
                "scope": "workflow",
                "execution_boundary": context.metadata.get("execution_boundary", "workflow"),
                "orchestration_session_path": str(session_path.relative_to(context.repo_root)),
                "orchestration_summary_path": str(summary_path.relative_to(context.repo_root)),
                "max_transitions": self._max_transitions,
                "workflow_step_command": (
                    "./harness --repo-root . workflow-step run "
                    f"--session {session_path.relative_to(context.repo_root)} --step-id <STEP-ID>"
                ),
                "final_response_contract": {
                    "channel": "final-message",
                    "format": "markdown",
                    "output": str(summary_path.relative_to(context.repo_root)),
                    "handoff_type": "orchestration-summary",
                },
            },
        )

    def _orchestrator_context(self, context: RunContext, session_path: Path) -> RunContext:
        metadata = {
            **dict(context.metadata),
            "orchestrator_owner": True,
            "progress_owner": "workflow_orchestrator_agent",
            "engine_role": "single_step_executor",
            "orchestration_session_path": str(session_path.relative_to(context.repo_root)),
            "workflow_step_command": (
                "./harness --repo-root . workflow-step run "
                f"--session {session_path.relative_to(context.repo_root)} --step-id <STEP-ID>"
            ),
        }
        return RunContext(
            run_id=context.run_id,
            workflow_name=context.workflow_name,
            mode=context.mode,
            repo_root=context.repo_root,
            workdir=context.workdir,
            run_dir=context.run_dir,
            active_plan_path=context.active_plan_path,
            architecture_path=context.architecture_path,
            metadata=metadata,
        )


def _run_status_for_orchestrator_result(result: StepResult) -> RunStatus:
    if result.status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED}:
        return RunStatus.SUCCEEDED
    if result.status is StepStatus.FAILED:
        return RunStatus.FAILED
    return RunStatus.BLOCKED
