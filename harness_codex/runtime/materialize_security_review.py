"""Materialize read-only security review responses into runtime artifacts."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from harness_codex.runtime.xml_handoff import write_handoff


STATUS_LABEL = "Security Review Status"
APPROVED_STATUS = "approved"
REJECTED_STATUS = "rejected"
_ALLOWED_STATUSES = {APPROVED_STATUS, REJECTED_STATUS}


class SecurityReviewMaterializationError(ValueError):
    """Raised when a final response cannot satisfy the security report contract."""


class SecurityReviewRejected(SecurityReviewMaterializationError):
    """Raised after a valid rejected report has been materialized."""


def materialize_security_review(source: Path, output: Path, verdict_output: Path | None = None) -> str:
    """Copy one final agent response to the declared report path and validate its status.

    The source is produced by the runtime's agent adapter, outside the reviewer's
    read-only sandbox. A rejected report is deliberately written before raising so
    downstream diagnostics retain the review findings while delivery remains blocked.
    """

    if not source.is_file():
        raise SecurityReviewMaterializationError(
            f"missing security review final response: {source}"
        )

    text = source.read_text(encoding="utf-8")
    if not text.strip():
        raise SecurityReviewMaterializationError(
            f"empty security review final response: {source}"
        )

    status = security_review_status(text)
    if status is None:
        raise SecurityReviewMaterializationError(
            f"security review final response missing `{STATUS_LABEL}: approved|rejected`"
        )
    if status not in _ALLOWED_STATUSES:
        raise SecurityReviewMaterializationError(
            f"security review status is `{status}`, expected `approved` or `rejected`"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text.rstrip() + "\n", encoding="utf-8")
    verdict_path = verdict_output or output.with_suffix(".xml")
    write_handoff(
        verdict_path,
        "gate-verdict",
        {
            "schema_version": 1,
            "gate_id": "security-review",
            "status": "approved" if status == APPROVED_STATUS else "rejected",
            "source_path": str(output),
            "status_label": STATUS_LABEL,
            "observed_status": status,
        },
    )

    if status == REJECTED_STATUS:
        raise SecurityReviewRejected("security review status is `rejected`")
    return status


def security_review_status(text: str) -> str | None:
    """Return the normalized review status from a Markdown final response."""

    prefix = f"{STATUS_LABEL}:"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped[len(prefix) :].strip().lower()
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Materialize and validate a read-only security reviewer final response."
    )
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--verdict-output", type=Path)
    args = parser.parse_args(argv)

    try:
        materialize_security_review(args.source, args.output, args.verdict_output)
    except SecurityReviewRejected as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except SecurityReviewMaterializationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
