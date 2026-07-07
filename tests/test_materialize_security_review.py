from __future__ import annotations

import pytest

from harness_codex.runtime.materialize_security_review import (
    SecurityReviewRejected,
    materialize_security_review,
)
from harness_codex.runtime.xml_handoff import read_handoff


def test_materializes_security_review_xml_verdict(tmp_path):
    source = tmp_path / "final-message.md"
    output = tmp_path / "security-review.md"
    verdict = tmp_path / "security-review.xml"
    source.write_text("Security Review Status: approved\n", encoding="utf-8")

    assert materialize_security_review(source, output, verdict) == "approved"

    payload = read_handoff(verdict, expected_type="gate-verdict")
    assert payload["status"] == "approved"
    assert payload["source_path"] == str(output)


def test_rejected_security_review_writes_xml_before_raising(tmp_path):
    source = tmp_path / "final-message.md"
    output = tmp_path / "security-review.md"
    verdict = tmp_path / "security-review.xml"
    source.write_text("Security Review Status: rejected\n", encoding="utf-8")

    with pytest.raises(SecurityReviewRejected):
        materialize_security_review(source, output, verdict)

    assert read_handoff(verdict, expected_type="gate-verdict")["status"] == "rejected"
