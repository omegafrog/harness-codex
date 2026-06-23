"""CLI wrapper that enriches verifier output with structured failure routing."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.verification_failure import classify_verification_failure
from harness_codex.runtime.verify_work_item import verify_work_item


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
    else:
        payload.update(
            {
                "failure_class": None,
                "owner_stage": None,
                "recommended_resume_target": None,
                "evidence": [],
            }
        )

    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _write_markdown_summary(root / result.evidence_dir / "verification.md", payload)

    status = "PASS" if result.passed else "FAIL"
    print(f"{status} work-item verification: {result.evidence_dir / 'report.json'}")
    if not result.passed:
        print(f"Failure class: {payload['failure_class']}")
        print(f"Owner stage: {payload['owner_stage']}")
        print(f"Recommended resume target: {payload['recommended_resume_target']}")
    return 0 if result.passed else 1


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
