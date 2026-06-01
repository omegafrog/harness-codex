"""Models for document contracts."""

from __future__ import annotations

from dataclasses import dataclass


DEFAULT_DASHBOARD_FIELDS = ("status", "blocker", "approval_status", "checksum", "stale")


@dataclass(frozen=True)
class DocumentProducer:
    """Runtime producer identity for one artifact contract."""

    skill: str = ""
    agent: str = ""
    runtime: str = ""


@dataclass(frozen=True)
class DocumentContract:
    """Contract for one harness artifact type."""

    doc_type: str
    path_pattern: str
    owner_stage: str
    producer: DocumentProducer
    consumes: tuple[str, ...] = ()
    produces: tuple[str, ...] = ()
    gates: tuple[str, ...] = ()
    stales_downstream: tuple[str, ...] = ()
    dashboard_fields: tuple[str, ...] = DEFAULT_DASHBOARD_FIELDS
