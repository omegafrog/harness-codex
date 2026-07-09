"""Structured step evidence for frontier hints and diff-contract verification.

These contracts model #460's policy directly:

* readFrontier is runtime/tool generated starting context, not an executor read gate.
* editHypothesis is an optional area-level hypothesis, not a file allowlist.
* actualChanges are derived from git diff first and then enriched with executor explanation.
* diffContract is verified after execution by comparing git diff, actualChanges,
  intent links, boundary edges, and test evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable


class DiffContractLevel(str, Enum):
    """Verifier severity for one diff-contract finding."""

    ALLOW = "allow"
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
class EditHypothesis:
    """Optional area-level guess about where the fix may happen.

    This replaces file-level writeIntent. It is allowed to be vague and must not
    be interpreted as a required edit list, write allowlist, or verifier gate.
    """

    area: str
    reason: str
    confidence: str = "low"


@dataclass(frozen=True)
class FrontierExpansion:
    """Executor-discovered context expansion.

    This records why the executor inspected or changed context outside the initial
    frontier. It explains discovery, but it is not required for every file read.
    Cross-boundary expansion should include an edge path such as event, API, ACL,
    message, outbox, or contract-test traversal.
    """

    path: Path
    reason: str
    edge_path: str = ""
    query: str = ""


@dataclass(frozen=True)
class ActualChange:
    """One changed file with runtime diff data and executor explanation.

    The changed file list should be generated from git diff first. The executor
    only enriches it with reason, linked intent, and optional boundary edge.
    """

    path: Path
    action: str
    reason: str
    linked_intent: str = ""
    boundary_edge: str = ""


@dataclass(frozen=True)
class TestEvidence:
    """Command/result evidence collected during execution or verification."""

    command: str
    result: str
    reason: str = ""


@dataclass(frozen=True)
class StepXmlContract:
    """Structured evidence exchanged between plan/execute/verify steps."""

    work_item_id: str
    work_item_type: str
    intent_summary: str = ""
    read_frontier: tuple[ReadFrontierCandidate, ...] = ()
    edit_hypotheses: tuple[EditHypothesis, ...] = ()
    frontier_expansion: tuple[FrontierExpansion, ...] = ()
    actual_changes: tuple[ActualChange, ...] = ()
    test_evidence: tuple[TestEvidence, ...] = ()
    test_obligations: tuple[str, ...] = ()

    def read_frontier_paths(self) -> frozenset[Path]:
        return frozenset(candidate.path for candidate in self.read_frontier)

    def actual_change_paths(self) -> frozenset[Path]:
        return frozenset(change.path for change in self.actual_changes)

    def frontier_expansion_paths(self) -> frozenset[Path]:
        return frozenset(expansion.path for expansion in self.frontier_expansion)


@dataclass(frozen=True)
class DiffContractFinding:
    level: DiffContractLevel
    code: str
    path: Path | None = None
    message: str = ""


@dataclass(frozen=True)
class DiffContractResult:
    findings: tuple[DiffContractFinding, ...] = ()

    @property
    def blocked(self) -> bool:
        return any(finding.level is DiffContractLevel.BLOCK for finding in self.findings)

    @property
    def warnings(self) -> tuple[DiffContractFinding, ...]:
        return tuple(finding for finding in self.findings if finding.level is DiffContractLevel.WARN)

    @property
    def blockers(self) -> tuple[DiffContractFinding, ...]:
        return tuple(finding for finding in self.findings if finding.level is DiffContractLevel.BLOCK)


def evaluate_diff_contract(
    *,
    plan_contract: StepXmlContract,
    execute_contract: StepXmlContract,
    git_diff_paths: Iterable[Path | str],
) -> DiffContractResult:
    """Evaluate git diff against executor accountability, not frontier gates.

    The initial read frontier is not a hard gate for reading or editing files.
    Edit hypotheses are area-level guesses and are also ignored for gating. A
    changed file passes when the executor records an actualChange with reason,
    linked intent, and sufficient test evidence. This function only blocks when
    the changed file is unexplained or the explanation lacks required proof.
    """

    findings: list[DiffContractFinding] = []
    normalized_diff = frozenset(Path(path) for path in git_diff_paths)
    actual_by_path = {change.path: change for change in execute_contract.actual_changes}
    expansion_paths = execute_contract.frontier_expansion_paths()
    evidence = execute_contract.test_evidence

    for path in sorted(normalized_diff):
        actual = actual_by_path.get(path)
        if actual is None:
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_ACTUAL_CHANGE",
                    path=path,
                    message="git diff contains a file not recorded in execute actualChanges",
                )
            )
            continue
        if not actual.reason.strip():
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_CHANGE_REASON",
                    path=path,
                    message="actualChanges entry must explain why the file changed",
                )
            )
        if not actual.linked_intent.strip():
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_LINKED_INTENT",
                    path=path,
                    message="actualChanges entry must link the change to ChangeSet/work-item intent",
                )
            )
        if _looks_cross_boundary(actual) and not actual.boundary_edge.strip():
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_BOUNDARY_EDGE",
                    path=path,
                    message="cross-boundary change requires event/API/ACL/message/outbox/contract-test edge",
                )
            )
        if not evidence:
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_TEST_EVIDENCE",
                    path=path,
                    message="implementation diff requires test evidence",
                )
            )
        if path not in plan_contract.read_frontier_paths() and path in expansion_paths:
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.WARN,
                    code="FRONTIER_EXPANDED",
                    path=path,
                    message="file was outside initial frontier but recorded as discovered context",
                )
            )

    for change in execute_contract.actual_changes:
        if change.path not in normalized_diff:
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.WARN,
                    code="ACTUAL_CHANGE_WITHOUT_DIFF",
                    path=change.path,
                    message="actualChanges records a file absent from git diff",
                )
            )

    for obligation in plan_contract.test_obligations:
        if not _evidence_mentions_obligation(evidence, obligation):
            findings.append(
                DiffContractFinding(
                    level=DiffContractLevel.BLOCK,
                    code="MISSING_TEST_OBLIGATION_EVIDENCE",
                    message=f"missing test evidence for obligation: {obligation}",
                )
            )

    return DiffContractResult(tuple(findings))


def _evidence_mentions_obligation(evidence: tuple[TestEvidence, ...], obligation: str) -> bool:
    normalized = obligation.strip().lower()
    if not normalized:
        return True
    return any(
        normalized in item.reason.lower() or normalized in item.command.lower()
        for item in evidence
    )


def _looks_cross_boundary(change: ActualChange) -> bool:
    hint = f"{change.path} {change.reason} {change.linked_intent}".lower()
    return any(
        token in hint
        for token in (
            "cross-bc",
            "cross bounded",
            "boundary",
            "acl",
            "event",
            "message",
            "outbox",
            "contract",
        )
    )
