import json
from pathlib import Path

from harness_codex.runtime.security_review_bundle import (
    materialize_security_profile,
    materialize_security_review_bundle,
)


def test_security_profile_selects_signaled_controls(tmp_path: Path) -> None:
    standards = tmp_path / ".codex/security/owasp-standards.json"
    standards.parent.mkdir(parents=True)
    standards.write_text(json.dumps({"standards": [{"id": "asvs", "name": "ASVS", "expected_version": "5.0.0"}]}), encoding="utf-8")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Plan\n\nImplement JWT authentication for a public API endpoint.\n", encoding="utf-8")

    profile, controls = materialize_security_profile(
        repo_root=tmp_path,
        plan_path=plan,
        profile_output=tmp_path / "profile.json",
        controls_output=tmp_path / "controls.json",
    )

    assert profile["signals"]["authentication_changed"] is True
    assert profile["signals"]["public_http_endpoint"] is True
    assert profile["routing"] == "independent-review"
    assert {item["id"] for item in controls["selected_controls"]} >= {"ASVS-V2", "ASVS-V4"}


def test_security_bundle_uses_scope_diff_paths(tmp_path: Path, monkeypatch) -> None:
    run_id = "run-001"
    scope = tmp_path / ".harness/runs" / run_id / "steps/execute-work-item/scope-diff-report.json"
    scope.parent.mkdir(parents=True)
    scope.write_text(json.dumps({"allowed": [{"path": "src/App.py", "operation": "modify"}]}), encoding="utf-8")
    plan = tmp_path / "plan.md"
    plan.write_text("## OWASP Security Review\n\n- [ ] validate input\n", encoding="utf-8")
    profile = tmp_path / "profile.json"
    profile.write_text("{}\n", encoding="utf-8")
    controls = tmp_path / "controls.json"
    controls.write_text("{}\n", encoding="utf-8")
    report = tmp_path / "report.json"
    report.write_text("{}\n", encoding="utf-8")
    verification = tmp_path / "verification.md"
    verification.write_text("PASS\n", encoding="utf-8")

    class Result:
        returncode = 0
        stdout = "diff --git a/src/App.py b/src/App.py\n"
        stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *args, **kwargs: Result())
    output = tmp_path / "bundle"
    manifest = materialize_security_review_bundle(
        repo_root=tmp_path,
        run_id=run_id,
        work_item_id="UC-001",
        plan_path=plan,
        profile_path=profile,
        controls_path=controls,
        verification_report_path=report,
        verification_markdown_path=verification,
        output_dir=output,
    )

    assert "implementation.diff" in manifest["files"]
    assert json.loads((output / "changed-files.json").read_text(encoding="utf-8"))["files"] == [{"path": "src/App.py", "operation": "modify"}]
    assert "diff --git" in (output / "implementation.diff").read_text(encoding="utf-8")
