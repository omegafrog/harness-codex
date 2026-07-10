"""Contracts between the workflow brain and local runtime services.

The runtime does not implement workflow progression. These types describe the
handoff shape an orchestration agent uses when it chooses a step, delegates that
step to a subagent/tool, receives a result, and chooses the next route.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Mapping, Protocol, Sequence

from harness_codex.runtime.models import StepStatus


OrchestrationDecisionStatus = Literal["continue", "blocked", "complete"]


@dataclass(frozen=True)
class SubagentInvocation:
    """One subagent call selected by the orchestration agent."""

    step_id: str
    agent_id: str
    skill_id: str
    inputs: tuple[Path, ...] = ()
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SubagentStepResult:
    """Result returned by a subagent after executing one selected step skill."""

    step_id: str
    status: StepStatus
    reason: str = ""
    evidence_path: str = ""
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class OrchestrationDecision:
    """Workflow-brain decision. This is never produced by a verifier/gate."""

    status: OrchestrationDecisionStatus
    reason: str = ""
    next_invocation: SubagentInvocation | None = None


class OrchestrationAgent(Protocol):
    """Workflow brain that owns progression, retry, remediation, and routing."""

    def select_next_invocation(
        self,
        *,
        instruction: str,
        history: Sequence[SubagentStepResult],
        runtime_metadata: Mapping[str, object],
    ) -> OrchestrationDecision:
        """Choose the next subagent invocation or terminal orchestration status."""
        ...

    def receive_step_result(
        self,
        result: SubagentStepResult,
        *,
        runtime_metadata: Mapping[str, object],
    ) -> OrchestrationDecision:
        """Accept one subagent result and decide the next route."""
        ...


class SubagentExecutor(Protocol):
    """Executes exactly one selected step skill and returns a step result."""

    def execute(self, invocation: SubagentInvocation) -> SubagentStepResult:
        """Run the selected step; do not choose the next route."""
        ...
