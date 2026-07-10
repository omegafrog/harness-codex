"""Structured classification for work-item verification verdicts.

The verifier-owned contract is intentionally verdict-only. It may classify the
failure and attach evidence, but it must not choose owner stages, resume targets,
retry targets, or remediation routes. Those routing decisions belong to the
workflow/orchestration layer that consumes the verdict.
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
    """Verdict classification written by a verifier."""

    failure_class: VerificationFailureClass
    evidence: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "failure_class": self.failure_class.value,
            "evidence": list(self.evidence),
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
    "existing-build-test-failure",
    "pre-existing",
    "non-uc",
    "unrelated existing",
    "cache configuration does not exist",
)

FORBIDDEN_ROUTING_KEYS = frozenset(
    {
        "owner_stage",
        "recommended_resume_target",
        "resume_target",
        "retry_target",
        "repair",
        "repair_brief_path",
        "repair_verification_order",
        "remediation_route",
    }
)


def contains_forbidden_routing_key(value: object) -> bool:
    """Reject routing decisions embedded at any depth in verifier output."""

    if isinstance(value, Mapping):
        return any(
            key in FORBIDDEN_ROUTING_KEYS or contains_forbidden_routing_key(child)
            for key, child in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(contains_forbidden_routing_key(item) for item in value)
    return False


def structured_failure_from_report(payload: Mapping[str, object]) -> VerificationFailure | None:
    """Read a verdict-only failure report; routing fields invalidate it."""

    if contains_forbidden_routing_key(payload):
        return None
    verdict = payload.get("verdict")
    if not isinstance(verdict, Mapping) or verdict.get("status") not in {"fail", "blocked"}:
        return None
    raw_class = payload.get("failure_class") or verdict.get("rule_id")
    if not isinstance(raw_class, str) or not raw_class.strip():
        return None
    failure_class = _DIRECT_ALIASES.get(_normalize(raw_class))
    if failure_class is None:
        return None
    raw_evidence = payload.get("evidence")
    evidence = (
        tuple(
            str(item)
            for item in raw_evidence
            if isinstance(item, (str, int, float)) and str(item).strip()
        )
        if isinstance(raw_evidence, list)
        else ()
    )
    evidence_path = verdict.get("evidence_path")
    if isinstance(evidence_path, str) and evidence_path.strip():
        evidence = (*evidence, evidence_path)
    return VerificationFailure(failure_class=failure_class, evidence=evidence)
def classify_verification_failure(
    *,
    blocker: str | None = None,
    missing_obligations: Iterable[str] = (),
    command_failures: Iterable[str] = (),
    evidence: Iterable[str] = (),
) -> VerificationFailure:
    """Classify a failed verifier outcome without selecting a recovery route."""

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

    return VerificationFailure(failure_class=failure_class, evidence=evidence_items)


def _normalize(value: str) -> str:
    return value.strip().casefold().replace("-", "_").replace(" ", "_")
