from __future__ import annotations

from harness_codex.runtime.verification_failure import structured_failure_from_report


def _failure_report() -> dict[str, object]:
    return {
        "failure_class": "environment_blocker",
        "evidence": ["tool unavailable"],
        "verdict": {
            "status": "blocked",
            "rule_id": "environment_blocker",
            "reason": "tool unavailable",
            "evidence_path": "verification/evidence.txt",
            "violations": [],
        },
    }


def test_structured_failure_accepts_verdict_only_report() -> None:
    failure = structured_failure_from_report(_failure_report())

    assert failure is not None
    assert failure.as_dict() == {
        "failure_class": "environment_blocker",
        "evidence": ["tool unavailable", "verification/evidence.txt"],
    }


def test_structured_failure_rejects_nested_routing_fields() -> None:
    payload = _failure_report()
    payload["verdict"]["violations"] = [{"remediation_route": "environment"}]  # type: ignore[index]

    assert structured_failure_from_report(payload) is None
