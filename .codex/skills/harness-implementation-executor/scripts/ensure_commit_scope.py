#!/usr/bin/env python3
"""Stage된 ChangeSet 산출물을 차단한다."""

import subprocess
import sys


FORBIDDEN_PREFIXES = (
    "docs/changes/",
    "docs/use-cases/",
    "docs/plans/",
    ".harness/",
)


def main() -> None:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        text=True,
        capture_output=True,
        check=True,
    )
    forbidden = [
        path for path in result.stdout.splitlines() if path.startswith(FORBIDDEN_PREFIXES)
    ]
    if forbidden:
        print("ChangeSet 산출물이 stage되어 commit할 수 없습니다.", file=sys.stderr)
        print("\n".join(forbidden), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
