#!/usr/bin/env python3
"""사용자가 승인한 deferred finding Issue를 중복 없이 생성한다."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def command(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)


def finding_marker(changeset: str, finding_id: str) -> str:
    return f"Harness-Deferred-Finding: {changeset}:{finding_id}"


def reusable_issue(items: list[dict[str, Any]], marker: str) -> str | None:
    for issue in items:
        if marker in str(issue.get("body", "")) and issue.get("url"):
            return str(issue["url"])
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--changeset", required=True)
    parser.add_argument("--finding-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", required=True, type=Path)
    parser.add_argument("--user-approved", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.user_approved:
        print("사용자 승인 없이 deferred finding Issue를 생성할 수 없다.", file=sys.stderr)
        return 2

    body = args.body_file.read_text(encoding="utf-8")
    marker = finding_marker(args.changeset, args.finding_id)
    if marker not in body:
        print("Issue 본문에 deferred finding marker가 없다.", file=sys.stderr)
        return 2

    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "planned",
                    "repository": args.repository,
                    "finding_id": args.finding_id,
                    "title": args.title,
                },
                ensure_ascii=False,
            )
        )
        return 0

    if shutil.which("gh") is None:
        print("gh CLI가 없다.", file=sys.stderr)
        return 1

    existing = command(
        "gh",
        "issue",
        "list",
        "--repo",
        args.repository,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "title,url,body",
    )
    if existing.returncode != 0:
        print(existing.stderr.strip() or "GitHub Issue 목록을 읽지 못했다.", file=sys.stderr)
        return 1
    try:
        issues = json.loads(existing.stdout)
    except json.JSONDecodeError:
        print("GitHub Issue 목록 응답이 JSON이 아니다.", file=sys.stderr)
        return 1
    if not isinstance(issues, list):
        print("GitHub Issue 목록 응답 형식이 잘못됐다.", file=sys.stderr)
        return 1

    if url := reusable_issue(issues, marker):
        print(json.dumps({"status": "reused", "url": url}, ensure_ascii=False))
        return 0

    created = command(
        "gh",
        "issue",
        "create",
        "--repo",
        args.repository,
        "--title",
        args.title,
        "--body-file",
        str(args.body_file),
    )
    if created.returncode != 0:
        print(created.stderr.strip() or "GitHub Issue를 만들지 못했다.", file=sys.stderr)
        return 1
    print(json.dumps({"status": "created", "url": created.stdout.strip()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
