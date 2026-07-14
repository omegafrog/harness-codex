#!/usr/bin/env python3
"""ChangeSet 전달 Issue를 중복 없이 생성한다."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def command(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--changeset", required=True)
    parser.add_argument("--kind", choices=("implementation", "bootstrap"), required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    body = args.body_file.read_text(encoding="utf-8")
    marker = f"Harness-ChangeSet: {args.changeset}\nHarness-Delivery-Kind: {args.kind}"
    if marker not in body:
        print("Issue 본문에 ChangeSet marker가 없다.", file=sys.stderr)
        return 2
    if args.dry_run:
        print(json.dumps({"status": "planned", "repository": args.repository, "title": args.title}, ensure_ascii=False))
        return 0
    if shutil.which("gh") is None:
        print("gh CLI가 없다.", file=sys.stderr)
        return 1
    existing = command("gh", "issue", "list", "--repo", args.repository, "--state", "open", "--limit", "100", "--json", "title,url")
    if existing.returncode != 0:
        print(existing.stderr.strip() or "GitHub Issue 목록을 읽지 못했다.", file=sys.stderr)
        return 1
    for issue in json.loads(existing.stdout):
        if issue.get("title") == args.title:
            print(json.dumps({"status": "reused", "url": issue["url"]}, ensure_ascii=False))
            return 0
    created = command("gh", "issue", "create", "--repo", args.repository, "--title", args.title, "--body-file", str(args.body_file))
    if created.returncode != 0:
        print(created.stderr.strip() or "GitHub Issue를 만들지 못했다.", file=sys.stderr)
        return 1
    print(json.dumps({"status": "created", "url": created.stdout.strip()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
