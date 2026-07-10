"""XML-only structured work-item verification verdict."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.verification_failure import classify_verification_failure
from harness_codex.runtime.verify_work_item import WorkItemVerificationResult, verify_work_item
from xml.etree import ElementTree as ET

from harness_codex.runtime.subagent_contract import RESULT_NS


def verify_and_classify_xml(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    force_verification: bool = False,
) -> int:
    """Run verifier and write one canonical XML file containing verdict and evidence."""

    root = Path(repo_root)
    result = verify_work_item(
        root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        force_verification=force_verification,
        write_legacy_reports=False,
    )
    output = root / result.evidence_dir / "subagent-result.xml"
    _write_subagent_result(output, root, result, run_id=run_id)
    status = "succeeded" if result.passed else "failed"
    print(f"{status} work-item verification: {output.relative_to(root)}")
    if not result.passed:
        print(f"Failure class: {_failure_class(root, result)}")
        print(f"Reason: {result.blocker or 'verification command failed'}")
    return 0 if result.passed else 1


def _write_subagent_result(path: Path, repo_root: Path, result: WorkItemVerificationResult, *, run_id: str) -> None:
    """Persist verification as the common subagent-result contract."""
    ET.register_namespace("", RESULT_NS)
    root = ET.Element(f"{{{RESULT_NS}}}subagent-result", {"schemaVersion": "1"})
    ET.SubElement(root, f"{{{RESULT_NS}}}identity", {"runId": run_id, "stepId": "verify-work-item", "attemptId": "attempt-1"})
    ET.SubElement(root, f"{{{RESULT_NS}}}delegate", {"agentId": "qa_inspector", "skillId": "harness-verification"})
    outcome_status = "succeeded" if result.passed else ("blocked" if result.blocker else "failed")
    outcome = ET.SubElement(root, f"{{{RESULT_NS}}}outcome", {"status": outcome_status})
    ET.SubElement(outcome, f"{{{RESULT_NS}}}summary").text = result.blocker or ("verification passed" if result.passed else "verification command failed")
    if not result.passed:
        failure = ET.SubElement(outcome, f"{{{RESULT_NS}}}failure", {"code": _failure_class(repo_root, result), "category": "environment" if result.blocker else "implementation"})
        ET.SubElement(failure, f"{{{RESULT_NS}}}message").text = result.blocker or "verification command failed"
    verification = ET.SubElement(root, f"{{{RESULT_NS}}}verification")
    ET.SubElement(verification, f"{{{RESULT_NS}}}subject", {
        "planPath": str(result.plan_path),
        "planSha256": _file_sha256(repo_root / result.plan_path),
        "goalPath": str(result.verification_goal_path),
        "goalSha256": _file_sha256(repo_root / result.verification_goal_path),
    })
    commands = ET.SubElement(verification, f"{{{RESULT_NS}}}commands")
    violations = ET.SubElement(verification, f"{{{RESULT_NS}}}violations")
    for index, command in enumerate(result.command_results, start=1):
        command_id = f"command-{index}"
        ET.SubElement(commands, f"{{{RESULT_NS}}}command", {
            "id": command_id,
            "source": command.source,
            "exitCode": str(command.exit_code),
            "stdoutPath": str(command.stdout_path),
            "stderrPath": str(command.stderr_path),
        })
        if not command.passed:
            violation = ET.SubElement(violations, f"{{{RESULT_NS}}}violation", {"code": "command-failed", "evidenceRef": f"evidence-{index}"})
            ET.SubElement(violation, f"{{{RESULT_NS}}}message").text = command.command
    ET.SubElement(verification, f"{{{RESULT_NS}}}fingerprint").text = result.verification_fingerprint or ""
    ET.SubElement(root, f"{{{RESULT_NS}}}artifacts")
    evidence = ET.SubElement(root, f"{{{RESULT_NS}}}evidence")
    for index, item in enumerate(result.evidence_items, start=1):
        node = ET.SubElement(evidence, f"{{{RESULT_NS}}}item", {"id": f"evidence-{index}", "path": str(item.path)})
        node.text = item.content
    for name in ("changes", "blockers"):
        ET.SubElement(root, f"{{{RESULT_NS}}}{name}")
    ET.indent(root, space="  ")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def _failure_class(repo_root: Path, result: WorkItemVerificationResult) -> str:
    if result.passed:
        return "verification"
    failure = classify_verification_failure(
        blocker=result.blocker,
        missing_obligations=result.missing_obligations,
        command_failures=_command_failure_text(repo_root, result),
        evidence=_failure_evidence(repo_root, result),
    )
    return failure.failure_class.value


def _file_sha256(path: Path) -> str:
    if not path.is_file():
        return ""
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _failure_evidence(repo_root: Path, result: WorkItemVerificationResult) -> list[str]:
    evidence: list[str] = []
    if result.blocker:
        evidence.append(f"blocker: {result.blocker}")
    evidence.extend(f"missing obligation: {item}" for item in result.missing_obligations)
    evidence.extend(result.document_evidence)
    for item in result.evidence_items:
        evidence.append(f"evidence: {item.label}: {item.status}: {item.path}")
        if item.content:
            evidence.append(f"evidence content: {item.label}: {item.content}")
    for command in result.command_results:
        if command.passed:
            continue
        evidence.extend(
            (
                f"failed command: {command.command}",
                f"stdout: {command.stdout_path}",
                f"stderr: {command.stderr_path}",
            )
        )
        for path in (repo_root / command.stderr_path, repo_root / command.stdout_path):
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace").strip()
                if text:
                    evidence.append(text[:4000])
    return list(dict.fromkeys(evidence))


def _command_failure_text(repo_root: Path, result: WorkItemVerificationResult) -> list[str]:
    failures: list[str] = []
    for command in result.command_results:
        if command.passed:
            continue
        for path in (repo_root / command.stderr_path, repo_root / command.stdout_path):
            if path.is_file():
                failures.append(path.read_text(encoding="utf-8", errors="replace"))
    return failures


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--force", action="store_true", dest="force_verification")
    args = parser.parse_args(argv)
    return verify_and_classify_xml(
        args.repo_root,
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        run_id=args.run_id,
        force_verification=args.force_verification,
    )


if __name__ == "__main__":
    raise SystemExit(main())
