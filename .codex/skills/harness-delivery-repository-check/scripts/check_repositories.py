#!/usr/bin/env python3
"""외부 저장소 전달 대상의 Harness 준비 상태를 검사한다."""

from __future__ import annotations

import argparse
import json
import subprocess
import tomllib
from pathlib import Path


MAP_PATH = Path(".harness/repositories.toml")
REQUIRED_PATHS = (
    Path(".codex/skills/harness-orchestrate-instruction/SKILL.md"),
    Path(".codex/workflow/token-estimation.md"),
    Path("harness"),
    Path("harness_codex"),
)


def external_repositories(plan: Path) -> list[str]:
    lines = plan.read_text(encoding="utf-8").splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == "## 외부 저장소 전달"), None)
    if start is None:
        return []
    rows: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        if not line.startswith("|") or "---" in line:
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and cells[0] != "저장소" and cells[0] and cells[0] != "current":
            rows.append(cells[0])
    return list(dict.fromkeys(rows))


def git_repository(path: Path) -> bool:
    return subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
        text=True,
        capture_output=True,
        check=False,
    ).returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    args = parser.parse_args()
    root = args.repo_root.resolve()
    plan = args.plan.resolve()
    identifiers = external_repositories(plan)
    if not identifiers:
        print(json.dumps({"status": "ready", "repositories": []}, ensure_ascii=False))
        return 0

    map_file = root / MAP_PATH
    if not map_file.is_file():
        print(json.dumps({"status": "blocked", "reason": f"missing repository map: {MAP_PATH}", "repositories": identifiers}, ensure_ascii=False))
        return 1
    with map_file.open("rb") as stream:
        mapped = tomllib.load(stream).get("repository", [])
    by_id = {entry.get("id"): entry for entry in mapped if isinstance(entry, dict) and isinstance(entry.get("id"), str)}
    results = []
    for identifier in identifiers:
        entry = by_id.get(identifier)
        if entry is None:
            results.append({"id": identifier, "ready": False, "reason": "repository map entry missing"})
            continue
        target = (root / str(entry.get("path", ""))).resolve()
        missing = [str(item) for item in REQUIRED_PATHS if not (target / item).exists()]
        github = entry.get("github")
        reason = ""
        if not target.is_dir() or not git_repository(target):
            reason = "repository path is unavailable or not a Git repository"
        elif not isinstance(github, str) or not github.strip():
            reason = "GitHub repository is missing"
        elif missing:
            reason = "Harness is not initialized: " + ", ".join(missing)
        bootstrap_required = bool(
            target.is_dir()
            and git_repository(target)
            and isinstance(github, str)
            and github.strip()
            and missing
        )
        results.append({"id": identifier, "path": str(target), "github": github, "ready": not reason, "bootstrap_required": bootstrap_required, "reason": reason})
    ready = all(item["ready"] for item in results)
    print(json.dumps({"status": "ready" if ready else "blocked", "repositories": results}, ensure_ascii=False))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
