"""XML contract adapter for structured work-item verification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.structured_verify_work_item import verify_and_classify
from harness_codex.runtime.xml_handoff import write_handoff


def verify_and_classify_xml(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    force_verification: bool = False,
) -> int:
    """Run the existing verifier and materialize its contract as XML."""

    root = Path(repo_root)
    code = verify_and_classify(
        root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        force_verification=force_verification,
    )
    evidence = root / ".harness/runs" / run_id / "work-items" / work_item_id / "verification"
    raw_report = evidence / "report.json"
    try:
        report = json.loads(raw_report.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError("verifier did not produce its raw report evidence") from exc
    if not isinstance(report, dict):
        raise RuntimeError("verifier raw report is not an object")
    report.update(
        {
            "schema_version": int(report.get("schema_version", 1)),
            "change_set_id": change_set_id,
            "work_item_id": work_item_id,
            "run_id": run_id,
            "status": "PASS" if code == 0 else "FAIL",
        }
    )
    repair_xml = evidence / "repair-brief.xml"
    raw_repair = evidence / "repair-brief.json"
    if raw_repair.is_file():
        try:
            repair = json.loads(raw_repair.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeError("invalid verifier repair brief evidence") from exc
        if isinstance(repair, dict):
            repair["schema_version"] = int(repair.get("schema_version", 1))
            repair["change_set_id"] = change_set_id
            repair["work_item_id"] = work_item_id
            repair["run_id"] = run_id
            repair.setdefault("resume_target", "execute-work-item")
            write_handoff(repair_xml, "repair-brief", repair)
            report["repair_brief_path"] = str(repair_xml.relative_to(root))
    else:
        repair_xml.unlink(missing_ok=True)
        report["repair_brief_path"] = None
    write_handoff(evidence / "verification.xml", "verification-report", report)
    return code


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
