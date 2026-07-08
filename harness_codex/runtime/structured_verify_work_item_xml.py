"""XML-only structured work-item verification."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.verification_failure import classify_verification_failure
from harness_codex.runtime.verify_work_item import WorkItemVerificationResult, verify_work_item
from harness_codex.runtime.xml_handoff import write_handoff

_REPAIR_VERIFICATION_ORDER = (
    "Run every failed verification command first.",
    "Then run all applicable required verification gates before completion.",
)


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
        print(f"Owner stage: {payload['owner_stage']}")
        print(f"Recommended resume target: {payload['recommended_resume_target']}")
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
        owner_stage = None
        resume_target = None
        failure_fingerprint = None
        repair: dict[str, object] = {}
    else:
        command_failures = _command_failure_text(repo_root, result)
        failure = classify_verification_failure(
            blocker=result.blocker,
            missing_obligations=result.missing_obligations,
            command_failures=command_failures,
            evidence=evidence,
        )
        failure_class = failure.failure_class.value
        owner_stage = failure.owner_stage
        resume_target = failure.recommended_resume_target
        failure_fingerprint = _failure_fingerprint(
            failure_class=failure_class,
            blocker=result.blocker,
            unmet_obligations=unmet_obligations,
            failed_commands=failed_commands,
        )
        repair = {
            "resume_target": "execute-work-item",
            "failure": {
                "class": failure_class,
                "fingerprint": failure_fingerprint,
                "failed_step": "verify-work-item",
                "verification_report": str(result.evidence_dir / "verification.xml"),
                "failed_gates": failed_gates,
                "failed_commands": failed_commands,
                "unmet_obligations": unmet_obligations,
                "evidence": evidence,
            },
            "repair_contract": {
                "allowed_changes": [
                    "approved code, tests, configuration, and verification evidence inside the active Work Item",
                    "unchecked implementation tasks and Runtime Remediation entries in the active plan",
                ],
                "prohibited_changes": [
                    "weakening tests, acceptance criteria, scope boundaries, or verification goals",
                    "editing unrelated Work Items or ChangeSets",
                    "moving the active plan to completed",
                ],
            },
            "verification_order": list(_REPAIR_VERIFICATION_ORDER),
        }

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
        "failure_class": failure_class,
        "owner_stage": owner_stage,
        "recommended_resume_target": resume_target,
        "failure_fingerprint": failure_fingerprint,
        "failed_gates": failed_gates,
        "failed_commands": failed_commands,
        "unmet_obligations": unmet_obligations,
        "repair": repair,
        "repair_verification_order": list(_REPAIR_VERIFICATION_ORDER) if not result.passed else [],
        "evidence": evidence,
    }


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
    encoded = json.dumps(
        {
            "failure_class": failure_class,
            "blocker": " ".join((blocker or "").split()),
            "unmet_obligations": sorted(" ".join(item.split()) for item in unmet_obligations),
            "failed_commands": normalized_commands,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _file_sha256(path: Path) -> str:
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--force-verification", action="store_true")
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
