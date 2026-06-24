"""CLI wrapper that enriches verifier output with structured failure routing."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Mapping, Sequence

from harness_codex.runtime.verification_failure import classify_verification_failure
from harness_codex.runtime.verify_work_item import WorkItemVerificationResult, verify_work_item


_REPAIR_VERIFICATION_ORDER = (
    "Run every failed verification command first.",
    "Then run all applicable required verification gates before completion.",
)


def verify_and_classify(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    force_verification: bool = False,
) -> int:
    root = Path(repo_root)
    result = verify_work_item(
        root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        force_verification=force_verification,
    )
    report_path = root / result.evidence_dir / "report.json"
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    repair_brief_path = root / result.evidence_dir / "repair-brief.json"

    if not result.passed:
        command_failures: list[str] = []
        evidence: list[str] = []
        if result.blocker:
            evidence.append(f"blocker: {result.blocker}")
        evidence.extend(f"missing obligation: {item}" for item in result.missing_obligations)
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
            stderr_path = root / command.stderr_path
            stdout_path = root / command.stdout_path
            for path in (stderr_path, stdout_path):
                if path.is_file():
                    command_failures.append(path.read_text(encoding="utf-8", errors="replace"))
        failure = classify_verification_failure(
            blocker=result.blocker,
            missing_obligations=result.missing_obligations,
            command_failures=command_failures,
            evidence=evidence,
        )
        payload.update(failure.as_dict())
        repair_inputs = _repair_inputs(result, failure_class=failure.failure_class.value, evidence=evidence)
        payload.update(repair_inputs)
        _write_repair_brief(
            repair_brief_path,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            run_id=run_id,
            payload=payload,
        )
    else:
        payload.update(
            {
                "failure_class": None,
                "owner_stage": None,
                "recommended_resume_target": None,
                "evidence": [],
                "failure_fingerprint": None,
                "failed_gates": [],
                "failed_commands": [],
                "unmet_obligations": [],
                "repair_brief_path": None,
                "repair_verification_order": [],
            }
        )
        if repair_brief_path.exists():
            repair_brief_path.unlink()

    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _write_markdown_summary(root / result.evidence_dir / "verification.md", payload)

    status = "PASS" if result.passed else "FAIL"
    print(f"{status} work-item verification: {result.evidence_dir / 'report.json'}")
    if not result.passed:
        print(f"Failure class: {payload['failure_class']}")
        print(f"Owner stage: {payload['owner_stage']}")
        print(f"Recommended resume target: {payload['recommended_resume_target']}")
        print(f"Repair brief: {payload['repair_brief_path']}")
    return 0 if result.passed else 1


def _repair_inputs(
    result: WorkItemVerificationResult,
    *,
    failure_class: str,
    evidence: list[str],
) -> dict[str, object]:
    failed_commands = [
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
    failed_gates = list(
        dict.fromkeys(
            command["name"] if command["source"] == ".codex/test-gate.yaml" else command["source"]
            for command in failed_commands
        )
    )
    unmet_obligations = list(result.missing_obligations)
    failure_fingerprint = _failure_fingerprint(
        failure_class=failure_class,
        blocker=result.blocker,
        unmet_obligations=unmet_obligations,
        failed_commands=failed_commands,
    )
    return {
        "failure_fingerprint": failure_fingerprint,
        "failed_gates": failed_gates,
        "failed_commands": failed_commands,
        "unmet_obligations": unmet_obligations,
        "repair_brief_path": str(result.evidence_dir / "repair-brief.json"),
        "repair_verification_order": list(_REPAIR_VERIFICATION_ORDER),
        "evidence": list(dict.fromkeys(evidence)),
    }


def _failure_fingerprint(
    *,
    failure_class: str,
    blocker: str | None,
    unmet_obligations: list[str],
    failed_commands: list[dict[str, object]],
) -> str:
    """Return a stable identity for repeated failures, excluding volatile log text."""

    normalized = {
        "failure_class": failure_class,
        "blocker": " ".join((blocker or "").split()),
        "unmet_obligations": sorted(" ".join(item.split()) for item in unmet_obligations),
        "failed_commands": sorted(
            {
                "name": str(command["name"]),
                "command": str(command["command"]),
                "source": str(command["source"]),
            }
            for command in failed_commands
        ),
    }
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _write_repair_brief(
    path: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    payload: Mapping[str, object],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    brief = {
        "schema_version": 1,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
        "run_id": run_id,
        "repair_attempt": None,
        "resume_target": "execute-work-item",
        "failure": {
            "class": payload.get("failure_class"),
            "fingerprint": payload.get("failure_fingerprint"),
            "failed_step": "verify-work-item",
            "verification_report": str(path.with_name("report.json")),
            "failed_gates": payload.get("failed_gates", []),
            "failed_commands": payload.get("failed_commands", []),
            "unmet_obligations": payload.get("unmet_obligations", []),
            "evidence": payload.get("evidence", []),
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
    path.write_text(json.dumps(brief, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_markdown_summary(path: Path, payload: dict[str, object]) -> None:
    if not payload.get("failure_class"):
        return
    lines = path.read_text(encoding="utf-8").rstrip().splitlines()
    lines.extend(
        (
            "",
            "## Failure Routing",
            f"- Failure class: `{payload['failure_class']}`",
            f"- Owner stage: `{payload['owner_stage']}`",
            f"- Recommended resume target: `{payload['recommended_resume_target']}`",
            f"- Failure fingerprint: `{payload['failure_fingerprint']}`",
            f"- Repair brief: `{payload['repair_brief_path']}`",
            "",
            "## Failure Evidence",
            *[f"- {item}" for item in payload.get("evidence", [])],
        )
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify one ChangeSet work item and write structured failure routing."
    )
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--force-verification", action="store_true")
    args = parser.parse_args(argv)
    return verify_and_classify(
        args.repo_root,
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        run_id=args.run_id,
        force_verification=args.force_verification,
    )


if __name__ == "__main__":
    raise SystemExit(main())
