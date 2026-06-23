from __future__ import annotations

import pytest

from harness_codex.runtime.verification_failure import (
    VerificationFailureClass,
    classify_verification_failure,
    structured_failure_from_report,
)


@pytest.mark.parametrize(
    ("blocker", "expected_class", "owner", "resume"),
    [
        ("ordinary assertion failed", VerificationFailureClass.IMPLEMENTATION_FAILURE, "implementation", "remediate-work-item"),
        ("E2E goal is unclear", VerificationFailureClass.UNCLEAR_E2E_GOAL, "e2e-goal", "e2e-goal-approval"),
        ("document delta conflict", VerificationFailureClass.DOCUMENT_DELTA_CONFLICT, "changeset", "change-set-revision"),
        ("upstream design conflict", VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT, "upstream-design", "upstream-design-stage"),
        ("environment blocker: docker daemon unavailable", VerificationFailureClass.ENVIRONMENT_BLOCKER, "environment", "environment"),
        ("scope conflict: changed file is out of scope", VerificationFailureClass.SCOPE_CONFLICT, "changeset", "change-set-revision"),
        ("security review rejected the change", VerificationFailureClass.SECURITY_REVIEW_FAILURE, "security-review", "security-review"),
        ("verification goal unclear", VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR, "verification-goal", "verification-goal-approval"),
    ],
)
def test_classify_verification_failure_selects_owner_and_resume_target(
    blocker: str,
    expected_class: VerificationFailureClass,
    owner: str,
    resume: str,
) -> None:
    failure = classify_verification_failure(blocker=blocker, evidence=(f"blocker: {blocker}",))

    assert failure.failure_class is expected_class
    assert failure.owner_stage == owner
    assert failure.recommended_resume_target == resume
    assert failure.evidence == (f"blocker: {blocker}",)


def test_environment_command_failure_is_not_implementation_failure() -> None:
    failure = classify_verification_failure(
        command_failures=("/bin/sh: docker: command not found",),
        evidence=("failed command: docker compose up",),
    )

    assert failure.failure_class is VerificationFailureClass.ENVIRONMENT_BLOCKER
    assert failure.recommended_resume_target == "environment"


def test_structured_failure_from_report_requires_complete_contract() -> None:
    assert structured_failure_from_report({"failure_class": "environment_blocker"}) is None

    failure = structured_failure_from_report(
        {
            "failure_class": "environment_blocker",
            "owner_stage": "environment",
            "recommended_resume_target": "environment",
            "evidence": ["stderr: verification/command-01.stderr.txt"],
        }
    )

    assert failure is not None
    assert failure.failure_class is VerificationFailureClass.ENVIRONMENT_BLOCKER
    assert failure.evidence == ("stderr: verification/command-01.stderr.txt",)
