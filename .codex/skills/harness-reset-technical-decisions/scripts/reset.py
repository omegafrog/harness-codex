#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--uc", required=True)
    return parser.parse_args()


def _validated_id(value: str, label: str) -> str:
    normalized = value.strip()
    if not ID_PATTERN.fullmatch(normalized):
        raise ValueError(f"{label} contains unsupported characters")
    return normalized


def _reset_stage_row(change_set_path: Path, uc_id: str) -> bool:
    text = change_set_path.read_text(encoding="utf-8")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = (
        "|technical-decisions|Technical Decisions|pending|"
        f"{now}|restarted from scratch for {uc_id}|"
    )
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("|technical-decisions|"):
            lines[index] = row
            change_set_path.write_text(
                "\n".join(lines) + ("\n" if text.endswith("\n") else ""),
                encoding="utf-8",
            )
            return True
    return False


def reset(repo_root: Path, change_set_id: str, uc_id: str) -> dict[str, object]:
    root = repo_root.resolve()
    change_set_id = _validated_id(change_set_id, "change_set")
    uc_id = _validated_id(uc_id, "uc")
    change_set_path = root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        raise ValueError(f"active ChangeSet does not exist: {change_set_path}")
    if "|technical-decisions|" not in change_set_path.read_text(encoding="utf-8"):
        raise ValueError("ChangeSet has no technical-decisions stage metadata")

    artifact_path = root / "docs" / "use-cases" / uc_id / "technical-decisions.md"
    artifact_deleted = artifact_path.is_file()
    artifact_path.unlink(missing_ok=True)

    cancelled_sessions: list[str] = []
    cancelled_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for session_path in (root / ".harness" / "runs").glob(
        "*/grill-me-session.json"
    ):
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(session, dict):
            continue
        if (
            session.get("change_set_id") != change_set_id
            or session.get("stage") != "technical-decisions"
            or str(session.get("uc_id", "")) != uc_id
            or session.get("status") not in {"running", "needs_input"}
        ):
            continue
        session["status"] = "cancelled"
        session["pending_questions"] = []
        session["blocker"] = ""
        session["cancelled_at"] = cancelled_at
        session["cancelled_reason"] = "technical decisions restarted from scratch"
        session_path.write_text(
            json.dumps(session, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        cancelled_sessions.append(str(session_path.relative_to(root)))

    job_path = (
        root / ".harness" / "ui" / "stage-rerun-jobs" / f"{change_set_id}.json"
    )
    persisted_job_deleted = False
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        job = {}
    if (
        isinstance(job, dict)
        and job.get("stage_id") == "technical-decisions"
        and str(job.get("uc_id", "")) == uc_id
    ):
        job_path.unlink(missing_ok=True)
        persisted_job_deleted = True

    return {
        "change_set_id": change_set_id,
        "uc_id": uc_id,
        "artifact_deleted": artifact_deleted,
        "cancelled_sessions": cancelled_sessions,
        "persisted_job_deleted": persisted_job_deleted,
        "stage_row_updated": _reset_stage_row(change_set_path, uc_id),
    }


def main() -> int:
    args = _parse_args()
    try:
        result = reset(Path(args.repo_root), args.change_set, args.uc)
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
