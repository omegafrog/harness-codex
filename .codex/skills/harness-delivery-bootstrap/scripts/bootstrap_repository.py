#!/usr/bin/env python3
"""현재 Harness source로 대상 Git repository를 초기화한다."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    source = args.source_root.resolve()
    target = args.target.resolve()
    installer = source / "scripts/install-harness-codex.sh"
    if not installer.is_file():
        print("현재 worktree에 Harness installer가 없다.", file=sys.stderr)
        return 1
    if not target.is_dir() or run("git", "-C", str(target), "rev-parse", "--is-inside-work-tree").returncode:
        print("대상은 Git repository여야 한다.", file=sys.stderr)
        return 1
    installed = run("bash", str(installer), "--runtime", "--target", str(target))
    if installed.returncode:
        print(installed.stderr.strip() or "Harness 설치에 실패했다.", file=sys.stderr)
        return 1
    initialized = run(str(target / "harness"), "init", "--description", "Harness 다중 저장소 전달 대상", "--no-llm")
    if initialized.returncode:
        print(initialized.stderr.strip() or "Harness 초기화에 실패했다.", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ready", "target": str(target)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
