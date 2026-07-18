from __future__ import annotations

import pytest

from harness_codex.runtime.contract_evidence import (
    BaselineObservation,
    EvidenceArtifact,
    ContractEnvelope,
    EvidenceEnvelope,
    EvidenceQuery,
    EvidenceResolutionStatus,
    EvidenceStatus,
    ProbeRequest,
    ProgressEvent,
    ProgressEventDeduplicator,
    Requirement,
    RequirementSet,
    ResourceDigest,
    ReusePolicy,
    compare_observations,
    content_digest,
    invalidated_requirements,
    read_evidence,
    resolve_evidence,
    run_probe,
    validate_contract,
    validate_evidence_artifacts,
    write_evidence,
)


def test_contract_validation_uses_caller_schema_and_opaque_ids() -> None:
    schema = b"caller-schema"
    payload = b"caller-payload"
    envelope = ContractEnvelope(
        schema_id="arbitrary/schema",
        schema_digest=content_digest(schema),
        subject_id="opaque-subject",
        subject_revision="revision-7",
        payload_ref="virtual:payload",
        payload_digest=content_digest(payload),
    )

    result = validate_contract(
        envelope,
        schema=schema,
        payload=payload,
        validator=lambda observed_schema, observed_payload: (
            () if observed_schema and observed_payload else ("empty",)
        ),
    )

    assert result.valid is True
    assert result.errors == ()
    assert result.envelope_fingerprint == envelope.fingerprint


def test_requirement_graph_invalidates_only_downstream_requirements() -> None:
    requirements = RequirementSet(
        (
            Requirement("alpha"),
            Requirement("beta", dependencies=("alpha",)),
            Requirement("gamma"),
            Requirement("delta", dependencies=("beta",)),
        )
    )

    assert invalidated_requirements(requirements, ("alpha",)) == (
        "alpha",
        "beta",
        "delta",
    )


def _evidence(**overrides: object) -> EvidenceEnvelope:
    values: dict[str, object] = {
        "requirement_id": "opaque-check",
        "subject_revision": "r1",
        "contract_digest": "contract",
        "input_fingerprint": "input",
        "environment_fingerprint": "environment",
        "invocation_fingerprint": "invocation",
        "producer_id": "producer",
        "status": EvidenceStatus.PASS,
        "started_at": "2026-01-01T00:00:00Z",
        "completed_at": "2026-01-01T00:00:01Z",
        "duration_seconds": 1.0,
    }
    values.update(overrides)
    return EvidenceEnvelope(**values)  # type: ignore[arg-type]


def _query(**overrides: str) -> EvidenceQuery:
    values = {
        "requirement_id": "opaque-check",
        "subject_revision": "r1",
        "contract_digest": "contract",
        "input_fingerprint": "input",
        "environment_fingerprint": "environment",
        "invocation_fingerprint": "invocation",
    }
    values.update(overrides)
    return EvidenceQuery(**values)


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("subject_revision", "different"),
        ("contract_digest", "different"),
        ("input_fingerprint", "different"),
        ("environment_fingerprint", "different"),
        ("invocation_fingerprint", "different"),
    ),
)
def test_evidence_reuse_requires_every_fingerprint_to_match(field: str, value: str) -> None:
    requirement = Requirement("opaque-check")

    assert resolve_evidence(requirement, _query(), (_evidence(),)).status is EvidenceResolutionStatus.REUSABLE
    assert resolve_evidence(requirement, _query(**{field: value}), (_evidence(),)).status is EvidenceResolutionStatus.STALE


def test_evidence_reuse_can_be_forbidden_or_require_independent_producer() -> None:
    forbidden = Requirement("opaque-check", reuse_policy=ReusePolicy.FORBID)
    assert resolve_evidence(forbidden, _query(), (_evidence(),)).status is EvidenceResolutionStatus.INVALID

    independent = _query(required_producer_id="independent")
    assert (
        resolve_evidence(Requirement("opaque-check"), independent, (_evidence(),)).status
        is EvidenceResolutionStatus.INVALID
    )


def test_evidence_round_trip_uses_caller_selected_location(tmp_path) -> None:
    path = tmp_path / "opaque" / "observation.json"

    assert write_evidence(path, _evidence()) == path
    assert read_evidence(path) == _evidence()


def test_probe_executes_only_caller_supplied_argv(tmp_path) -> None:
    request = ProbeRequest(
        probe_id="opaque-probe",
        argv=("python3", "-c", "print('observed')"),
        environment_fingerprint="environment",
        input_resources=(ResourceDigest.from_bytes("virtual:input", b"value"),),
    )

    observation = run_probe(request, cwd=tmp_path)

    assert observation.status == "pass"
    assert observation.exit_code == 0
    assert observation.stdout.strip() == "observed"


def test_evidence_artifacts_are_verified_through_opaque_loader() -> None:
    content = b"artifact"
    evidence = _evidence(
        artifacts=(EvidenceArtifact("opaque:artifact", content_digest(content)),)
    )

    valid = validate_evidence_artifacts(
        evidence,
        loader=lambda artifact_ref: content if artifact_ref == "opaque:artifact" else b"",
    )
    invalid = validate_evidence_artifacts(evidence, loader=lambda _: b"different")

    assert valid.valid is True
    assert invalid.valid is False


def test_baseline_comparison_returns_facts_without_remediation() -> None:
    delta = compare_observations(
        BaselineObservation("observation", "fail", "environment"),
        BaselineObservation("observation", "fail", "environment"),
    )

    assert delta.comparison == "unchanged"
    assert not hasattr(delta, "next_step")
    assert not hasattr(delta, "remediation")


def test_progress_events_emit_transitions_and_suppress_unchanged_duplicates() -> None:
    deduplicator = ProgressEventDeduplicator(heartbeat_seconds=60)

    first = deduplicator.observe(ProgressEvent("event", "1", "running", "same", occurred_at=0))
    duplicate = deduplicator.observe(ProgressEvent("event", "1", "running", "same", occurred_at=10))
    transition = deduplicator.observe(ProgressEvent("event", "2", "complete", "new", occurred_at=11))
    heartbeat = deduplicator.observe(ProgressEvent("event", "2", "complete", "new", occurred_at=72))

    assert first.emit is True
    assert duplicate.emit is False
    assert transition.emit is True
    assert heartbeat.emit is True
