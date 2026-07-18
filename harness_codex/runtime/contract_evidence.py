"""Technology-neutral contract, probe, evidence, and progress utilities.

The runtime deliberately treats identifiers, schemas, resources, requirements,
and producers as opaque caller-owned values.  It records observations and
validates references; it never chooses workflow stages, remediation, retries,
or completion.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence


def content_digest(content: bytes) -> str:
    """Return the canonical SHA-256 digest for caller-provided bytes."""

    return hashlib.sha256(content).hexdigest()


def canonical_digest(value: Mapping[str, object] | Sequence[object]) -> str:
    """Hash a JSON-compatible value without attaching domain meaning to it."""

    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return content_digest(encoded)


def _required(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label} must be non-empty")
    return normalized


@dataclass(frozen=True)
class ResourceDigest:
    """Opaque resource reference and its caller-observed content digest."""

    resource_id: str
    digest: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "resource_id", _required(self.resource_id, "resource_id"))
        object.__setattr__(self, "digest", _required(self.digest, "digest"))

    @classmethod
    def from_bytes(cls, resource_id: str, content: bytes) -> "ResourceDigest":
        return cls(resource_id=resource_id, digest=content_digest(content))

    def as_dict(self) -> dict[str, str]:
        return {"resource_id": self.resource_id, "digest": self.digest}


@dataclass(frozen=True)
class ContractEnvelope:
    """Caller-owned schema and payload identity presented to the runtime."""

    schema_id: str
    schema_digest: str
    subject_id: str
    subject_revision: str
    payload_ref: str
    payload_digest: str
    contract_version: str = "1"

    def __post_init__(self) -> None:
        for name in (
            "schema_id",
            "schema_digest",
            "subject_id",
            "subject_revision",
            "payload_ref",
            "payload_digest",
            "contract_version",
        ):
            object.__setattr__(self, name, _required(getattr(self, name), name))

    def as_dict(self) -> dict[str, str]:
        return {
            "schema_id": self.schema_id,
            "schema_digest": self.schema_digest,
            "subject_id": self.subject_id,
            "subject_revision": self.subject_revision,
            "payload_ref": self.payload_ref,
            "payload_digest": self.payload_digest,
            "contract_version": self.contract_version,
        }

    @property
    def fingerprint(self) -> str:
        return canonical_digest(self.as_dict())


@dataclass(frozen=True)
class ContractValidationObservation:
    """Facts observed while validating a caller-supplied contract."""

    valid: bool
    errors: tuple[str, ...] = ()
    envelope_fingerprint: str = ""


ContractValidator = Callable[[bytes, bytes], Iterable[str]]
ArtifactLoader = Callable[[str], bytes]


def validate_contract(
    envelope: ContractEnvelope,
    *,
    schema: bytes,
    payload: bytes,
    validator: ContractValidator,
) -> ContractValidationObservation:
    """Validate digests and delegate schema semantics to the caller validator."""

    errors: list[str] = []
    if content_digest(schema) != envelope.schema_digest:
        errors.append("schema digest mismatch")
    if content_digest(payload) != envelope.payload_digest:
        errors.append("payload digest mismatch")
    if not errors:
        errors.extend(str(error) for error in validator(schema, payload) if str(error).strip())
    return ContractValidationObservation(
        valid=not errors,
        errors=tuple(errors),
        envelope_fingerprint=envelope.fingerprint,
    )


class ReusePolicy(str, Enum):
    ALLOW = "allow"
    FORBID = "forbid"


@dataclass(frozen=True)
class Requirement:
    """Opaque obligation with generic dependency and reuse metadata."""

    requirement_id: str
    dependencies: tuple[str, ...] = ()
    reuse_policy: ReusePolicy = ReusePolicy.ALLOW

    def __post_init__(self) -> None:
        object.__setattr__(self, "requirement_id", _required(self.requirement_id, "requirement_id"))
        normalized = tuple(dict.fromkeys(_required(value, "dependency") for value in self.dependencies))
        if self.requirement_id in normalized:
            raise ValueError("requirement cannot depend on itself")
        object.__setattr__(self, "dependencies", normalized)

    def as_dict(self) -> dict[str, object]:
        return {
            "requirement_id": self.requirement_id,
            "dependencies": list(self.dependencies),
            "reuse_policy": self.reuse_policy.value,
        }


@dataclass(frozen=True)
class RequirementSet:
    """Validated dependency graph whose identifiers remain caller-owned."""

    requirements: tuple[Requirement, ...]

    def __post_init__(self) -> None:
        ids = tuple(requirement.requirement_id for requirement in self.requirements)
        if len(ids) != len(set(ids)):
            raise ValueError("requirement IDs must be unique")
        known = set(ids)
        for requirement in self.requirements:
            unknown = set(requirement.dependencies) - known
            if unknown:
                raise ValueError(
                    f"unknown dependencies for {requirement.requirement_id}: {sorted(unknown)}"
                )
        self._assert_acyclic()

    def _assert_acyclic(self) -> None:
        by_id = {item.requirement_id: item for item in self.requirements}
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(requirement_id: str) -> None:
            if requirement_id in visiting:
                raise ValueError("requirement dependency graph must be acyclic")
            if requirement_id in visited:
                return
            visiting.add(requirement_id)
            for dependency in by_id[requirement_id].dependencies:
                visit(dependency)
            visiting.remove(requirement_id)
            visited.add(requirement_id)

        for requirement_id in by_id:
            visit(requirement_id)

    def by_id(self, requirement_id: str) -> Requirement:
        for requirement in self.requirements:
            if requirement.requirement_id == requirement_id:
                return requirement
        raise KeyError(requirement_id)

    @property
    def fingerprint(self) -> str:
        return canonical_digest([item.as_dict() for item in self.requirements])


def invalidated_requirements(
    requirement_set: RequirementSet,
    directly_invalidated: Iterable[str],
) -> tuple[str, ...]:
    """Return direct invalidations and their transitive dependants in declaration order."""

    invalidated = set(directly_invalidated)
    unknown = invalidated - {item.requirement_id for item in requirement_set.requirements}
    if unknown:
        raise ValueError(f"unknown invalidated requirements: {sorted(unknown)}")
    changed = True
    while changed:
        changed = False
        for requirement in requirement_set.requirements:
            if requirement.requirement_id in invalidated:
                continue
            if invalidated.intersection(requirement.dependencies):
                invalidated.add(requirement.requirement_id)
                changed = True
    return tuple(
        item.requirement_id
        for item in requirement_set.requirements
        if item.requirement_id in invalidated
    )


@dataclass(frozen=True)
class ProbeRequest:
    """A deterministic invocation declared completely by the caller."""

    probe_id: str
    argv: tuple[str, ...]
    environment_fingerprint: str
    input_resources: tuple[ResourceDigest, ...] = ()
    timeout_seconds: float = 60.0
    expected_exit_codes: tuple[int, ...] = (0,)
    severity: str = "blocking"
    waiver_allowed: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "probe_id", _required(self.probe_id, "probe_id"))
        object.__setattr__(
            self,
            "environment_fingerprint",
            _required(self.environment_fingerprint, "environment_fingerprint"),
        )
        if not self.argv or any(not value.strip() for value in self.argv):
            raise ValueError("argv must contain non-empty values")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if not self.expected_exit_codes:
            raise ValueError("expected_exit_codes must not be empty")

    @property
    def fingerprint(self) -> str:
        return canonical_digest(
            {
                "probe_id": self.probe_id,
                "argv": list(self.argv),
                "input_resources": [item.as_dict() for item in self.input_resources],
                "environment_fingerprint": self.environment_fingerprint,
                "timeout_seconds": self.timeout_seconds,
                "expected_exit_codes": list(self.expected_exit_codes),
                "severity": self.severity,
                "waiver_allowed": self.waiver_allowed,
            }
        )


@dataclass(frozen=True)
class ProbeObservation:
    probe_id: str
    request_fingerprint: str
    status: str
    exit_code: int | None
    stdout: str
    stderr: str
    started_at: str
    completed_at: str
    duration_seconds: float
    error: str = ""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_probe(request: ProbeRequest, *, cwd: Path | str | None = None) -> ProbeObservation:
    """Execute one opaque argv request and return facts without remediation advice."""

    started_at = _utc_now()
    started = time.monotonic()
    try:
        completed = subprocess.run(
            request.argv,
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
            timeout=request.timeout_seconds,
        )
        status = "pass" if completed.returncode in request.expected_exit_codes else "fail"
        return ProbeObservation(
            probe_id=request.probe_id,
            request_fingerprint=request.fingerprint,
            status=status,
            exit_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            started_at=started_at,
            completed_at=_utc_now(),
            duration_seconds=time.monotonic() - started,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        stdout = error.stdout if isinstance(error, subprocess.TimeoutExpired) else ""
        stderr = error.stderr if isinstance(error, subprocess.TimeoutExpired) else ""
        return ProbeObservation(
            probe_id=request.probe_id,
            request_fingerprint=request.fingerprint,
            status="error",
            exit_code=None,
            stdout=stdout or "",
            stderr=stderr or "",
            started_at=started_at,
            completed_at=_utc_now(),
            duration_seconds=time.monotonic() - started,
            error=str(error),
        )


class EvidenceStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"


@dataclass(frozen=True)
class EvidenceArtifact:
    artifact_ref: str
    digest: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_ref", _required(self.artifact_ref, "artifact_ref"))
        object.__setattr__(self, "digest", _required(self.digest, "artifact digest"))

    def as_dict(self) -> dict[str, str]:
        return {"artifact_ref": self.artifact_ref, "digest": self.digest}


@dataclass(frozen=True)
class EvidenceEnvelope:
    """Portable observation record used for verification reuse decisions."""

    requirement_id: str
    subject_revision: str
    contract_digest: str
    input_fingerprint: str
    environment_fingerprint: str
    invocation_fingerprint: str
    producer_id: str
    status: EvidenceStatus
    started_at: str
    completed_at: str
    duration_seconds: float
    artifacts: tuple[EvidenceArtifact, ...] = ()
    reuse_policy: ReusePolicy = ReusePolicy.ALLOW

    def __post_init__(self) -> None:
        for name in (
            "requirement_id",
            "subject_revision",
            "contract_digest",
            "input_fingerprint",
            "environment_fingerprint",
            "invocation_fingerprint",
            "producer_id",
            "started_at",
            "completed_at",
        ):
            object.__setattr__(self, name, _required(getattr(self, name), name))
        if self.duration_seconds < 0:
            raise ValueError("duration_seconds must not be negative")

    def as_dict(self) -> dict[str, object]:
        return {
            "requirement_id": self.requirement_id,
            "subject_revision": self.subject_revision,
            "contract_digest": self.contract_digest,
            "input_fingerprint": self.input_fingerprint,
            "environment_fingerprint": self.environment_fingerprint,
            "invocation_fingerprint": self.invocation_fingerprint,
            "producer_id": self.producer_id,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "duration_seconds": self.duration_seconds,
            "artifacts": [artifact.as_dict() for artifact in self.artifacts],
            "reuse_policy": self.reuse_policy.value,
        }

    @property
    def fingerprint(self) -> str:
        return canonical_digest(self.as_dict())

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> "EvidenceEnvelope":
        raw_artifacts = value.get("artifacts", ())
        if not isinstance(raw_artifacts, Sequence) or isinstance(raw_artifacts, (str, bytes)):
            raise ValueError("artifacts must be a sequence")
        if any(not isinstance(item, Mapping) for item in raw_artifacts):
            raise ValueError("every artifact must be an object")
        artifacts = tuple(
            EvidenceArtifact(
                artifact_ref=str(item.get("artifact_ref", "")),
                digest=str(item.get("digest", "")),
            )
            for item in raw_artifacts
        )
        return cls(
            requirement_id=str(value.get("requirement_id", "")),
            subject_revision=str(value.get("subject_revision", "")),
            contract_digest=str(value.get("contract_digest", "")),
            input_fingerprint=str(value.get("input_fingerprint", "")),
            environment_fingerprint=str(value.get("environment_fingerprint", "")),
            invocation_fingerprint=str(value.get("invocation_fingerprint", "")),
            producer_id=str(value.get("producer_id", "")),
            status=EvidenceStatus(str(value.get("status", ""))),
            started_at=str(value.get("started_at", "")),
            completed_at=str(value.get("completed_at", "")),
            duration_seconds=float(value.get("duration_seconds", 0.0)),
            artifacts=artifacts,
            reuse_policy=ReusePolicy(str(value.get("reuse_policy", ReusePolicy.ALLOW.value))),
        )


def write_evidence(path: Path | str, evidence: EvidenceEnvelope) -> Path:
    """Atomically persist evidence to a caller-selected location."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    temporary.write_text(
        json.dumps(evidence.as_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(target)
    return target


def read_evidence(path: Path | str) -> EvidenceEnvelope:
    """Read evidence from a caller-selected location."""

    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError("evidence payload must be an object")
    return EvidenceEnvelope.from_dict(value)


@dataclass(frozen=True)
class ArtifactValidationObservation:
    valid: bool
    errors: tuple[str, ...] = ()


def validate_evidence_artifacts(
    evidence: EvidenceEnvelope,
    *,
    loader: ArtifactLoader,
) -> ArtifactValidationObservation:
    """Verify declared artifact bytes without interpreting their references."""

    errors: list[str] = []
    for artifact in evidence.artifacts:
        try:
            observed = content_digest(loader(artifact.artifact_ref))
        except (OSError, ValueError) as error:
            errors.append(f"{artifact.artifact_ref}: {error}")
            continue
        if observed != artifact.digest:
            errors.append(f"{artifact.artifact_ref}: digest mismatch")
    return ArtifactValidationObservation(valid=not errors, errors=tuple(errors))


@dataclass(frozen=True)
class EvidenceQuery:
    requirement_id: str
    subject_revision: str
    contract_digest: str
    input_fingerprint: str
    environment_fingerprint: str
    invocation_fingerprint: str
    required_producer_id: str = ""

    def __post_init__(self) -> None:
        for name in (
            "requirement_id",
            "subject_revision",
            "contract_digest",
            "input_fingerprint",
            "environment_fingerprint",
            "invocation_fingerprint",
        ):
            object.__setattr__(self, name, _required(getattr(self, name), name))


class EvidenceResolutionStatus(str, Enum):
    REUSABLE = "reusable"
    STALE = "stale"
    MISSING = "missing"
    INVALID = "invalid"


@dataclass(frozen=True)
class EvidenceResolution:
    status: EvidenceResolutionStatus
    reason: str
    evidence: EvidenceEnvelope | None = None


def resolve_evidence(
    requirement: Requirement,
    query: EvidenceQuery,
    candidates: Iterable[EvidenceEnvelope],
) -> EvidenceResolution:
    """Resolve reusable evidence using only caller-provided identities."""

    matching_id = [item for item in candidates if item.requirement_id == query.requirement_id]
    if not matching_id:
        return EvidenceResolution(EvidenceResolutionStatus.MISSING, "no evidence for requirement")
    expected = (
        query.subject_revision,
        query.contract_digest,
        query.input_fingerprint,
        query.environment_fingerprint,
        query.invocation_fingerprint,
    )
    if requirement.reuse_policy is ReusePolicy.FORBID:
        return EvidenceResolution(EvidenceResolutionStatus.INVALID, "reuse is forbidden", matching_id[-1])
    exact: list[EvidenceEnvelope] = []
    for candidate in reversed(matching_id):
        observed = (
            candidate.subject_revision,
            candidate.contract_digest,
            candidate.input_fingerprint,
            candidate.environment_fingerprint,
            candidate.invocation_fingerprint,
        )
        if observed != expected:
            continue
        exact.append(candidate)
        if candidate.reuse_policy is ReusePolicy.FORBID:
            continue
        if candidate.status is not EvidenceStatus.PASS:
            continue
        if query.required_producer_id and candidate.producer_id != query.required_producer_id:
            continue
        return EvidenceResolution(
            EvidenceResolutionStatus.REUSABLE,
            "evidence fingerprints match",
            candidate,
        )
    if exact:
        return EvidenceResolution(
            EvidenceResolutionStatus.INVALID,
            "matching evidence did not satisfy status, reuse, or producer constraints",
            exact[0],
        )
    return EvidenceResolution(
        EvidenceResolutionStatus.STALE,
        "evidence fingerprint mismatch",
        matching_id[-1],
    )


@dataclass(frozen=True)
class BaselineObservation:
    observation_id: str
    status: str
    environment_fingerprint: str


@dataclass(frozen=True)
class ObservationDelta:
    observation_id: str
    comparison: str
    before_status: str
    after_status: str


def compare_observations(
    before: BaselineObservation,
    after: BaselineObservation,
) -> ObservationDelta:
    """Compare two observations without choosing a workflow response."""

    if before.observation_id != after.observation_id:
        raise ValueError("observation IDs must match")
    if before.environment_fingerprint != after.environment_fingerprint:
        comparison = "incomparable"
    elif before.status == after.status:
        comparison = "unchanged"
    elif before.status == "pass" and after.status != "pass":
        comparison = "regressed"
    elif before.status != "pass" and after.status == "pass":
        comparison = "improved"
    else:
        comparison = "changed"
    return ObservationDelta(
        observation_id=before.observation_id,
        comparison=comparison,
        before_status=before.status,
        after_status=after.status,
    )


@dataclass(frozen=True)
class ProgressEvent:
    event_key: str
    revision: str
    state: str
    summary_digest: str
    occurred_at: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        for name in ("event_key", "revision", "state", "summary_digest"):
            object.__setattr__(self, name, _required(getattr(self, name), name))


@dataclass(frozen=True)
class ProgressDecision:
    emit: bool
    reason: str


class ProgressEventDeduplicator:
    """Suppress unchanged progress until a configurable heartbeat elapses."""

    def __init__(self, *, heartbeat_seconds: float = 600.0) -> None:
        if heartbeat_seconds <= 0:
            raise ValueError("heartbeat_seconds must be positive")
        self.heartbeat_seconds = heartbeat_seconds
        self._latest: dict[str, ProgressEvent] = {}

    def observe(self, event: ProgressEvent) -> ProgressDecision:
        previous = self._latest.get(event.event_key)
        if previous is None:
            self._latest[event.event_key] = event
            return ProgressDecision(True, "first observation")
        changed = (
            previous.revision != event.revision
            or previous.state != event.state
            or previous.summary_digest != event.summary_digest
        )
        if changed:
            self._latest[event.event_key] = event
            return ProgressDecision(True, "state or summary changed")
        if event.occurred_at - previous.occurred_at >= self.heartbeat_seconds:
            self._latest[event.event_key] = event
            return ProgressDecision(True, "heartbeat elapsed")
        return ProgressDecision(False, "unchanged duplicate")


__all__ = [
    "BaselineObservation",
    "ArtifactValidationObservation",
    "ContractEnvelope",
    "ContractValidationObservation",
    "EvidenceArtifact",
    "EvidenceEnvelope",
    "EvidenceQuery",
    "EvidenceResolution",
    "EvidenceResolutionStatus",
    "EvidenceStatus",
    "ObservationDelta",
    "ProbeObservation",
    "ProbeRequest",
    "ProgressDecision",
    "ProgressEvent",
    "ProgressEventDeduplicator",
    "Requirement",
    "RequirementSet",
    "ResourceDigest",
    "ReusePolicy",
    "canonical_digest",
    "compare_observations",
    "content_digest",
    "invalidated_requirements",
    "read_evidence",
    "resolve_evidence",
    "run_probe",
    "validate_contract",
    "validate_evidence_artifacts",
    "write_evidence",
]
