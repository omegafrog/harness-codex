#!/usr/bin/env python3
"""Check pinned OWASP standards against official release sources."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_REGISTRY = Path(".codex/security/owasp-standards.json")
USER_AGENT = "harness-owasp-standards-checker/1"


@dataclass(frozen=True)
class StandardResult:
    standard_id: str
    name: str
    expected: str
    discovered: str | None
    status: str
    source: str
    reference: str
    error: str = ""


Fetcher = Callable[[str], Any]


def fetch_json(url: str) -> Any:
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8")


def semantic_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def discover_version(
    standard: dict[str, Any],
    *,
    json_fetcher: Fetcher = fetch_json,
    text_fetcher: Fetcher = fetch_text,
) -> str:
    discovery = standard["discovery"]
    source = standard["source"]
    if discovery == "github_stable_release":
        releases = json_fetcher(source)
        pattern = re.compile(standard["release_pattern"])
        versions = []
        for release in releases:
            if release.get("draft") or release.get("prerelease"):
                continue
            match = pattern.fullmatch(str(release.get("tag_name") or ""))
            if match:
                versions.append(match.group("version"))
        if not versions:
            raise ValueError("no stable release matched release_pattern")
        return max(versions, key=semantic_key)
    if discovery == "text_pattern":
        match = re.search(
            standard["version_pattern"],
            text_fetcher(source),
            flags=re.IGNORECASE,
        )
        if not match:
            raise ValueError("version_pattern did not match official source")
        return match.group("version")
    if discovery == "github_directory_year":
        entries = json_fetcher(source)
        years = [
            str(entry.get("name"))
            for entry in entries
            if re.fullmatch(r"[0-9]{4}", str(entry.get("name") or ""))
        ]
        if not years:
            raise ValueError("no edition year directory found")
        return max(years, key=int)
    raise ValueError(f"unsupported discovery strategy: {discovery}")


def check_registry(
    registry: dict[str, Any],
    *,
    today: date,
    json_fetcher: Fetcher = fetch_json,
    text_fetcher: Fetcher = fetch_text,
) -> tuple[list[StandardResult], bool]:
    results: list[StandardResult] = []
    for standard in registry["standards"]:
        try:
            discovered = discover_version(
                standard,
                json_fetcher=json_fetcher,
                text_fetcher=text_fetcher,
            )
            status = (
                "current"
                if discovered == standard["expected_version"]
                else "update_available"
            )
            error = ""
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            discovered = None
            status = "source_error"
            error = str(exc)
        results.append(
            StandardResult(
                standard_id=standard["id"],
                name=standard["name"],
                expected=standard["expected_version"],
                discovered=discovered,
                status=status,
                source=standard["source"],
                reference=standard["reference"],
                error=error,
            )
        )

    reviewed = date.fromisoformat(registry["last_reviewed_on"])
    stale = (today - reviewed).days > int(registry["review_interval_days"])
    return results, stale


def render_report(
    registry: dict[str, Any],
    results: list[StandardResult],
    *,
    checked_at: datetime,
    stale: bool,
) -> str:
    overall = "source_error" if any(r.status == "source_error" for r in results) else (
        "review_required"
        if stale or any(r.status == "update_available" for r in results)
        else "current"
    )
    lines = [
        "# OWASP Standards Update Check",
        "",
        f"- Checked at: `{checked_at.isoformat()}`",
        f"- Overall status: `{overall}`",
        f"- Last human review: `{registry['last_reviewed_on']}`",
        f"- Review interval: `{registry['review_interval_days']} days`",
        f"- Review stale: `{'yes' if stale else 'no'}`",
        "",
        "|Standard|Pinned|Discovered|Status|",
        "|---|---|---|---|",
    ]
    for result in results:
        lines.append(
            f"|[{result.name}]({result.reference})|`{result.expected}`|"
            f"`{result.discovered or '-'}`|`{result.status}`|"
        )
    errors = [result for result in results if result.error]
    if errors:
        lines.extend(["", "## Source Errors", ""])
        lines.extend(
            f"- `{result.standard_id}`: {result.error}" for result in errors
        )
    if overall == "review_required":
        lines.extend(
            [
                "",
                "## Required Review",
                "",
                "1. Read official release notes and migration guidance.",
                "2. Compare changed controls and identifiers with the reviewer baseline.",
                "3. Update the registry, OWASP baseline, agent contract, and contract tests.",
                "4. Run focused tests and a real-plan smoke test.",
                "5. Set `last_reviewed_on` only after human approval.",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--today", type=date.fromisoformat)
    args = parser.parse_args()

    registry = json.loads(args.registry.read_text(encoding="utf-8"))
    today = args.today or datetime.now(timezone.utc).date()
    checked_at = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    results, stale = check_registry(registry, today=today)
    report = render_report(registry, results, checked_at=checked_at, stale=stale)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding="utf-8")
    print(report, end="")
    if any(result.status == "source_error" for result in results):
        return 3
    if stale or any(result.status == "update_available" for result in results):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
