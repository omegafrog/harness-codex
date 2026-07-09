"""Minimal runtime evidence for frontier hints and mechanical verification.

These contracts keep runtime verification out of content/intent review:

* readFrontier is a runtime/tool generated starting hint, not an executor read gate.
* diffSummary is generated from git diff and records what changed, not why.
* verification only checks mechanical runtime facts such as diff collection and test
  gate status. Semantic correctness belongs to design, plan, and tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable


class VerificationLevel(str, Enum):
    """Runtime verification severity for mechanical findings."""

    INFO = "info"
    WARN = "warn"
    BLOCK = "block"


@dataclass(frozen=True)
class ReadFrontierCandidate:
    """A runtime/tool generated file/symbol/module to inspect first.

    This is deliberately advisory. It is not a read gate, not a write gate, and
    absence from this list must not block either file reads or implementation.
    The executor may inspect any additional file needed to understand the task.
    """

    path: Path
    reason: str
    symbol: str = ""
    priority: str = "medium"
    confidence: float | None = None
    edge_path: str = ""
    profile: str = ""
    source: str = "runtime"


@dataclass(frozen=True)
class DiffEntry:
    """One file entry collected from git diff.

    This is factual runtime evidence only. It intentionally does not require an
    agent-authored reason, linked intent, or semantic justification.
    """

    path: Path
    action: str


@dataclass(frozen=True)
class TestGateResult:
    """Result of the test gate selected by the plan/workflow profile."""

    command: str
    status: str
    output_path: Path | None = None


@dataclass(frozen=True)
class RuntimeEvidence:
    """Evidence exchanged between execute and verify steps."""

    work_item_id: str
    work_item_type: str
    read_frontier: tuple[ReadFrontierCandidate, ...] = ()
    diff_summary: tuple[DiffEntry, ...] = ()
    test_results: tuple[TestGateResult, ...] = ()

    def diff_paths(self) -> frozenset[Path]:
        return frozenset(entry.path for entry in self.diff_summary)


@dataclass(frozen=True)
class VerificationFinding:
    level: VerificationLevel
    code: str
    path: Path | None = None
    message: str = ""


@dataclass(frozen=True)
class RuntimeVerificationResult:
    """Mechanical verifier output consumed by the orchestrator."""

    findings: tuple[VerificationFinding, ...] = ()

    @property
    def blocked(self) -> bool:
        return any(finding.level is VerificationLevel.BLOCK for finding in self.findings)

    @property
    def warnings(self) -> tuple[VerificationFinding, ...]:
        return tuple(finding for finding in self.findings if finding.level is VerificationLevel.WARN)

    @property
    def blockers(self) -> tuple[VerificationFinding, ...]:
        return tuple(finding for finding in self.findings if finding.level is VerificationLevel.BLOCK)


def collect_diff_summary(git_diff_entries: Iterable[tuple[Path | str, str]]) -> tuple[DiffEntry, ...]:
    """Normalize git diff name-status output into factual runtime evidence."""

    return tuple(DiffEntry(path=Path(path), action=action) for path, action in git_diff_entries)


def verify_runtime_evidence(
    *,
    evidence: RuntimeEvidence,
    git_diff_paths: Iterable[Path | str],
    require_tests: bool = True,
) -> RuntimeVerificationResult:
    """Verify mechanical runtime facts without semantic content judgment.

    This verifier does not ask why files changed and does not decide whether the
    implementation is conceptually correct. That belongs to design/plan/test
    obligations. Here we only ensure the runtime captured the diff and that the
    selected test gate passed when required.
    """

    findings: list[VerificationFinding] = []
    actual_paths = frozenset(Path(path) for path in git_diff_paths)
    summary_paths = evidence.diff_paths()

    for path in sorted(actual_paths - summary_paths):
        findings.append(
            VerificationFinding(
                level=VerificationLevel.BLOCK,
                code="DIFF_SUMMARY_MISSING_FILE",
                path=path,
                message="git diff contains a file absent from diffSummary",
            )
        )
    for path in sorted(summary_paths - actual_paths):
        findings.append(
            VerificationFinding(
                level=VerificationLevel.WARN,
                code="DIFF_SUMMARY_STALE_FILE",
                path=path,
                message="diffSummary contains a file absent from current git diff",
            )
        )

    if require_tests and not evidence.test_results:
        findings.append(
            VerificationFinding(
                level=VerificationLevel.BLOCK,
                code="TEST_GATE_NOT_RUN",
                message="required test gate did not produce a result",
            )
        )
    for result in evidence.test_results:
        if result.status.lower() not in {"passed", "skipped"}:
            findings.append(
                VerificationFinding(
                    level=VerificationLevel.BLOCK,
                    code="TEST_GATE_FAILED",
                    message=f"test gate failed: {result.command}",
                )
            )

    return RuntimeVerificationResult(tuple(findings))
