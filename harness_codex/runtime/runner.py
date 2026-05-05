"""Step runner boundary for runtime execution.

`StepRunner` is the adapter boundary between the pure runtime engine and
side-effecting implementations such as Codex, shell, git, and validators.
"""

from __future__ import annotations

from typing import Protocol

from harness_codex.runtime.models import RunContext, Step, StepResult


class StepRunner(Protocol):
    """Adapter interface used by `RunnerEngine` to execute one step.

    Implementations may call Codex, shell, git, validators, or fake test doubles.

    The engine depends only on this protocol and never performs those side
    effects directly.
    """

    def run(self, step: Step, context: RunContext) -> StepResult:
        """Execute one step and return a structured result."""
        ...
