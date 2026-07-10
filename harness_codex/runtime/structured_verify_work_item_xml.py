"""XML-only structured work-item verification verdict."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.verification_failure import (
    VerificationFailureClass,
    classify_verification_failure,
)
from harness_codex.runtime.verify_work_item import WorkItemVerificationResult, verify_work_item
from harness_codex.runtime.xml_handoff import write_handoff


_BLOCKED_FAILURE_CLASSES = {
    VerificationFailureClass.UNCLEAR_E2E_GOAL.value,
    VerificationFailureClass.DOCUMENT_DELTA_CONFLICT.value,
    VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT.value,
    VerificationFailureClass.ENVIRONMENT_BLOCKER.value,
    VerificationFailureClass.SCOPE_CONFLICT.value,
    VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR.value,
}


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
    payload = _verification_payload(root, result, run_id=run_id)
    write_handoff(root / result.evidence_dir / "verification.xml", "verification-report", payload)
    status = "PASS" if result.passed else "FAIL"
    print(f"{status} work-item verification: {result.evidence_dir / 'verification.xml'}")
    if not result.passed:
        print(f"Failure class: {payload['failure_class']}")
        print(f"Reason: {payload['verdict']['reason']}")
    return 0 if result.passed else 1


def _verification_payload(
    repo_root: Path,
    result: WorkItemVerificationResult,
    *,
    run_id: str,
) -> dict[str, object]:
    evidence = _failure_evidence(repo_root, result)
    failed_commands = _failed_commands(result)
    failed_gates = list(
        dict.fromkeys(
            command["name"] if command["source"] == ".codex/test-gate.yaml" else command["source"]
            for command in failed_commands
        )
    )
    unmet_obligations = list(result.missing_obligations)
    if result.passed:
        failure_class = None
        failure_fingerprint = None
    else:
        command_failures = _command_failure_text(repo_root, result)
        failure = classify_verification_failure(
            blocker=result.blocker,
            missing_obligations=result.missing_obligations,
            command_failures=command_failures,
            evidence=evidence,
        )
        failure_class = failure.failure_class.value
        failure_fingerprint = _failure_fingerprint(
            failure_class=failure_class,
            blocker=result.blocker,
            unmet_obligations=unmet_obligations,
            failed_commands=failed_commands,
        )

    verdict = _verdict_payload(
        result,
        failure_class=failure_class,
        failed_gates=failed_gates,
        failed_commands=failed_commands,
        unmet_obligations=unmet_obligations,
    )

    return {
        "schema_version": 2,
        "change_set_id": result.change_set_id,
        "work_item_id": result.work_item_id,
        "run_id": run_id,
        "status": "PASS" if result.passed else "FAIL",
        "blocker": result.blocker,
        "plan_path": str(result.plan_path),
        "plan_sha256": _file_sha256(repo_root / result.plan_path),
        "verification_goal_path": str(result.verification_goal_path),
        "test_gate_path": str(result.test_gate_path),
        "evidence_dir": str(result.evidence_dir),
        "verification_fingerprint": result.verification_fingerprint,
        "missing_obligations": unmet_obligations,
        "document_evidence": list(result.document_evidence),
        "evidence_items": [
            {
                "label": item.label,
                "status": item.status,
                "path": str(item.path),
                "content": item.content,
            }
            for item in result.evidence_items
        ],
        "commands": [
            {
                "name": command.name,
                "command": command.command,
                "source": command.source,
                "exit_code": command.exit_code,
                "stdout_path": str(command.stdout_path),
                "stderr_path": str(command.stderr_path),
                "duration_seconds": command.duration_seconds,
                "reused": command.reused,
            }
            for command in result.command_results
        ],
        "gate_policy": result.gate_policy.as_dict() if result.gate_policy is not None else None,
        "verdict": verdict,
        "failure_class": failure_class,
        "failure_fingerprint": failure_fingerprint,
        "failed_gates": failed_gates,
        "failed_commands": failed_commands,
        "unmet_obligations": unmet_obligations,
        "evidence": evidence,
    }


def _verdict_payload(
    result: WorkItemVerificationResult,
    *,
    failure_class: str | None,
    failed_gates: list[str],
    failed_commands: list[dict[str, object]],
    unmet_obligations: list[str],
) -> dict[str, object]:
    violations: list[dict[str, object]] = []
    if result.blocker:
        violations.append({"type": "blocker", "detail": result.blocker})
    violations.extend({"type": "missing_obligation", "detail": item} for item in unmet_obligations)
    violations.extend({"type": "failed_gate", "detail": item} for item in failed_gates)
    violations.extend(
        {
            "type": "failed_command",
            "detail": command["command"],
            "stdout_path": command["stdout_path"],
            "stderr_path": command["stderr_path"],
        }
        for command in failed_commands
    )
    return {
        "status": _verdict_status(result, failure_class),
        "rule_id": failure_class or "work-item-verification",
        "reason": _verdict_reason(
            result,
            failure_class=failure_class,
            failed_commands=failed_commands,
            unmet_obligations=unmet_obligations,
        ),
        "evidence_path": str(result.evidence_dir / "verification.xml"),
        "violations": violations,
    }


def _verdict_status(result: WorkItemVerificationResult, failure_class: str | None) -> str:
    if result.passed:
        return "pass"
    if failure_class in _BLOCKED_FAILURE_CLASSES:
        return "blocked"
    return "fail"


def _verdict_reason(
    result: WorkItemVerificationResult,
    *,
    failure_class: str | None,
    failed_commands: list[dict[str, object]],
    unmet_obligations: list[str],
) -> str:
    if result.passed:
        return "verification passed"
    if result.blocker:
        return result.blocker
    if unmet_obligations:
        return "missing verification obligations: " + ", ".join(unmet_obligations)
    if failed_commands:
        return "verification command failed"
    return failure_class or "verification failed"


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


def _failed_commands(result: WorkItemVerificationResult) -> list[dict[str, object]]:
    return [
        {
            "name": command.name,
            "command": command.command,
            "source": command.source,
            "exit_code": command.exit_code,
            "stdout_path": str(command.stdout_path),
            "stderr_path": str(command.stderr_path),
        }
        for command in result.command_results
        if not command.passed
    ]


def _command_failure_text(repo_root: Path, result: WorkItemVerificationResult) -> list[str]:
    failures: list[str] = []
    for command in result.command_results:
        if command.passed:
            continue
        for path in (repo_root / command.stderr_path, repo_root / command.stdout_path):
            if path.is_file():
                failures.append(path.read_text(encoding="utf-8", errors="replace"))
    return failures


def _failure_fingerprint(
    *,
    failure_class: str,
    blocker: str | None,
    unmet_obligations: list[str],
    failed_commands: list[dict[str, object]],
) -> str:
    normalized_commands = sorted(
        [
            {
                "name": str(command["name"]),
                "command": str(command["command"]),
                "source": str(command["source"]),
            }
            for command in failed_commands
        ],
        key=lambda command: (command["name"], command["command"], command["source"]),
    )
    payload = {
        "failure_class": failure_class,
        "blocker": blocker or "",
        "unmet_obligations": sorted(unmet_obligations),
        "failed_commands": normalized_commands,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _file_sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
