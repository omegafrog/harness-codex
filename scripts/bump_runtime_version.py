#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


VERSION_PATTERN = re.compile(
    r'^(?P<prefix>__version__\s*=\s*")'
    r"(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r'(?P<suffix>"\s*)$',
    re.MULTILINE,
)


def bump_patch_version(text: str) -> tuple[str, str, str]:
    matches = list(VERSION_PATTERN.finditer(text))
    if len(matches) != 1:
        raise ValueError("expected exactly one semantic __version__ assignment")
    match = matches[0]
    before = ".".join(match.group(name) for name in ("major", "minor", "patch"))
    after = ".".join(
        [match.group("major"), match.group("minor"), str(int(match.group("patch")) + 1)]
    )
    replacement = f"{match.group('prefix')}{after}{match.group('suffix')}"
    updated = text[: match.start()] + replacement + text[match.end() :]
    return updated, before, after


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Increase the harness runtime patch version.")
    parser.add_argument(
        "--file",
        default="harness_codex/__init__.py",
        type=Path,
        help="Runtime version file to update.",
    )
    args = parser.parse_args(argv)
    try:
        original = args.file.read_text(encoding="utf-8")
        updated, before, after = bump_patch_version(original)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    args.file.write_text(updated, encoding="utf-8")
    print(f"{before} -> {after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
