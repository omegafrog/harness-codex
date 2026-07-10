"""Runtime-local step runner boundary.

The default runtime runner delegates record/shell/validator/git/agent execution to
``BasicStepRunner`` but refuses workflow-brain decision steps. This keeps
``BasicStepRunner`` available as a low-level adapter while the public runtime
execution path stays local-service-only.
"""

from __future__ import annotations

from harness_codex.runtime.models import FailureKind, RunContext, Step, StepKind, StepResult, StepStatus
from harness_codex.runtime.runner import BasicStepRunner, StepRunner


class LocalStepRunner:
    """Default runtime step runner used by public execution paths."""

    def __init__(self, delegate: StepRunner | None = None) -> None:
        self._delegate = delegate or BasicStepRunner()

    def run(self, step: Step, context: RunContext) -> StepResult:
        if step.kind is StepKind.DECISION:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="decision steps belong to the orchestration agent, not runtime execution",
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={
                    "runtime_contract": "decision-step-not-executed",
                    "orchestration_owner": "orchestration-agent",
                },
            )
        return self._delegate.run(step, context)
