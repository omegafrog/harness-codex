"""Structured classification for work-item verification failures.

This module is deliberately independent of the runner so the verifier can write a
stable report and the decision step can consume it without re-parsing command
exit codes or relying on free-form strings.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Mapping


class VerificationFailureClass(str, Enum):
    IMPLEMENTATION_FAILURE = "implementation_failure"
    UNCLEAR_E2E_GOAL = "unclear_e2e_goal"
    DOCUMENT_DELTA_CONFLICT = "document_delta_conflict"
    UPSTREAM_DESIGN_CONFLICT = "upstream_design_conflict"
    ENVIRONMENT_BLOCKER = "environment_blocker"
    SCOPE_CONFLICT = "scope_conflict"
    SECURITY_REVIEW_FAILURE = "security_review_failure"
    VERIFICATION_GOAL_UNCLEAR = "verification_goal_unclear"


@dataclass(frozen=True)
class VerificationFailure:
    """A durable verification failure contract written to ``report.json``."""

    failure_class: VerificationFailureClass
    owner_stage: str
    recommended_resume_target: str
    evidence: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "failure_class": self.failure_class.value,
            "owner_stage": self.owner_stage,
            "recommended_resume_target": self.recommended_resume_target,
            "evidence": list(self.evidence),
        }


_FAILURE_DEFAULTS: dict[VerificationFailureClass, tuple[str, str]] = {
    VerificationFailureClass.IMPLEMENTATION_FAILURE: ("implementation", "remediate-work-item"),
    VerificationFailureClass.UNCLEAR_E2E_GOAL: ("e2e-goal", "e2e-goal-approval"),
    VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: ("changeset", "change-set-revision"),
    VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: ("upstream-design", "upstream-design-stage"),
    VerificationFailureClass.ENVIRONMENT_BLOCKER: ("environment", "environment"),
    VerificationFailureClass.SCOPE_CONFLICT: ("changeset", "change-set-revision"),
    VerificationFailureClass.SECURITY_REVIEW_FAILURE: ("security-review", "security-review"),
    VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: (
        "verification-goal",
        "verification-goal-approval",
    ),
}

_DIRECT_ALIASES = {
    "implementation": VerificationFailureClass.IMPLEMENTATION_FAILURE,
    "implementation_failure": VerificationFailureClass.IMPLEMENTATION_FAILURE,
    "unclear_e2e_goal": VerificationFailureClass.UNCLEAR_E2E_GOAL,
    "document_delta_conflict": VerificationFailureClass.DOCUMENT_DELTA_CONFLICT,
    "upstream_design": VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT,
    "upstream_design_conflict": VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT,
    "environment_blocker": VerificationFailureClass.ENVIRONMENT_BLOCKER,
    "scope_conflict": VerificationFailureClass.SCOPE_CONFLICT,
    "security_review_failure": VerificationFailureClass.SECURITY_REVIEW_FAILURE,
    "verification_goal_unclear": VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR,
}

_ENVIRONMENT_MARKERS = (
    "command not found",
    "binary not found",
    "no such file or directory",
    "network is unreachable",
    "temporary failure in name resolution",
    "connection timed out",
    "timed out",
    "docker daemon",
    "service unavailable",
    "environment blocker",
)


def structured_failure_from_report(payload: Mapping[str, object]) -> VerificationFailure | None:
    """Read the report contract when all structured fields are present and valid."""

    raw_class = payload.get("failure_class")
    if not isinstance(raw_class, str) or not raw_class.strip():
        return None
    failure_class = _DIRECT_ALIASES.get(_normalize(raw_class))
    if failure_class is None:
        return None
    owner_stage = payload.get("owner_stage")
    resume_target = payload.get("recommended_resume_target")
    raw_evidence = payload.get("evidence")
    if not isinstance(owner_stage, str) or not owner_stage.strip():
        return None
    if not isinstance(resume_target, str) or not resume_target.strip():
        return None
    evidence = tuple(
        str(item)
        for item in raw_evidence
        if isinstance(item, (str, int, float))
    ) if isinstance(raw_evidence, list) else ()
    return VerificationFailure(
        failure_class=failure_class,
        owner_stage=owner_stage,
        recommended_resume_target=resume_target,
        evidence=evidence,
    )


def classify_verification_failure(
    *,
    blocker: str | None = None,
    missing_obligations: Iterable[str] = (),
    command_failures: Iterable[str] = (),
    evidence: Iterable[str] = (),
) -> VerificationFailure:
    """Classify a failed verifier outcome without treating exit code as its cause.

    Explicit failure labels in evidence win. Otherwise this only recognizes stable
    environmental/document/scope/design conditions and keeps ordinary failing
    tests as implementation failures.
    """

    evidence_items = tuple(str(item) for item in evidence if str(item).strip())
    text_parts = [blocker or "", *missing_obligations, *command_failures, *evidence_items]
    text = "\n".join(str(part) for part in text_parts).casefold()

    if "security review" in text or "security_review_failure" in text:
        failure_class = VerificationFailureClass.SECURITY_REVIEW_FAILURE
    elif any(marker in text for marker in _ENVIRONMENT_MARKERS):
        failure_class = VerificationFailureClass.ENVIRONMENT_BLOCKER
    elif "document delta" in text or "stale document" in text or "missing required verification files" in text:
        failure_class = VerificationFailureClass.DOCUMENT_DELTA_CONFLICT
    elif "scope conflict" in text or "out of scope" in text:
        failure_class = VerificationFailureClass.SCOPE_CONFLICT
    elif any(marker in text for marker in ("upstream design", "architecture conflict", "requirements conflict")):
        failure_class = VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT
    elif "e2e" in text and any(marker in text for marker in ("unclear", "ambiguous", "missing")):
        failure_class = VerificationFailureClass.UNCLEAR_E2E_GOAL
    elif (
        "verification goal" in text
        or "required verification evidence is missing" in text
        or "no product verification commands" in text
    ):
        failure_class = VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR
    else:
        failure_class = VerificationFailureClass.IMPLEMENTATION_FAILURE

    owner_stage, resume_target = _FAILURE_DEFAULTS[failure_class]
    return VerificationFailure(
        failure_class=failure_class,
        owner_stage=owner_stage,
        recommended_resume_target=resume_target,
        evidence=evidence_items,
    )


def failure_defaults(failure_class: VerificationFailureClass) -> tuple[str, str]:
    return _FAILURE_DEFAULTS[failure_class]


def _normalize(value: str) -> str:
    return value.strip().casefold().replace("-", "_").replace(" ", "_")
