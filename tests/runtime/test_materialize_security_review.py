from pathlib import Path

from harness_codex.runtime.materialize_security_review import main


APPROVED_REPORT = """# Security Review\n\nSecurity Review Status: approved\n\n## Reviewed Inputs\n- ChangeSet and implementation evidence\n\n## Security Findings\n- none\n\n## Remediation Target\nnone\n\n## Evidence\n- focused tests passed\n"""

REJECTED_REPORT = """# Security Review\n\nSecurity Review Status: rejected\n\n## Reviewed Inputs\n- ChangeSet and implementation evidence\n\n## Security Findings\n- Missing authorization check\n\n## Remediation Target\nimplementation\n\n## Evidence\n- focused tests passed\n"""


def test_runtime_materializes_approved_security_review_response(tmp_path: Path) -> None:
    source = tmp_path / "steps/review-work-item-security/final-message.md"
    output = tmp_path / "work-items/UC-001/security/security-review.md"
    source.parent.mkdir(parents=True)
    source.write_text(APPROVED_REPORT, encoding="utf-8")

    exit_code = main(["--source", str(source), "--output", str(output)])

    assert exit_code == 0
    assert output.read_text(encoding="utf-8") == APPROVED_REPORT
    assert source.read_text(encoding="utf-8") == APPROVED_REPORT


def test_runtime_materializes_rejected_security_review_before_blocking(tmp_path: Path) -> None:
    source = tmp_path / "steps/review-work-item-security/final-message.md"
    output = tmp_path / "work-items/UC-001/security/security-review.md"
    source.parent.mkdir(parents=True)
    source.write_text(REJECTED_REPORT, encoding="utf-8")

    exit_code = main(["--source", str(source), "--output", str(output)])

    assert exit_code == 2
    assert output.read_text(encoding="utf-8") == REJECTED_REPORT


def test_runtime_fails_when_security_review_final_response_is_missing(tmp_path: Path) -> None:
    source = tmp_path / "steps/review-work-item-security/final-message.md"
    output = tmp_path / "work-items/UC-001/security/security-review.md"

    exit_code = main(["--source", str(source), "--output", str(output)])

    assert exit_code == 1
    assert not output.exists()
