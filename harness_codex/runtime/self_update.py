"""Self-update helper for installed harness-codex runtimes."""

from __future__ import annotations

import argparse
import shlex
import subprocess
from pathlib import Path
from typing import Protocol

DEFAULT_REPO = "https://github.com/omegafrog/harness-codex"
DEFAULT_REF = "main"
INSTALLER_PATH = "scripts/install-harness-codex.sh"


class Runner(Protocol):
    def __call__(self, *args, **kwargs) -> subprocess.CompletedProcess[str]:
        ...


def main(argv: list[str] | None = None, *, repo_root: Path | str = ".") -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        output = run_self_update(Path(repo_root), args)
    except ValueError as exc:
        print(str(exc))
        return 2
    if output:
        print(output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness update",
        description="Update the installed harness-codex runtime in this project.",
        epilog=(
            "Update refreshes runtime-managed files while preserving workflow-generated "
            "artifacts such as runs, sessions, ChangeSets, plans, harvested docs, and "
            "project-local config."
        ),
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"harness-codex repository URL. Default: {DEFAULT_REPO}",
    )
    parser.add_argument(
        "--ref",
        default=DEFAULT_REF,
        help=f"branch, tag, or commit to install. Default: {DEFAULT_REF}",
    )
    parser.add_argument(
        "--skip-venv",
        action="store_true",
        help="Skip venv creation and dependency installation.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the installer command without running it.",
    )
    return parser


def run_self_update(
    repo_root: Path,
    args: argparse.Namespace,
    *,
    runner: Runner = subprocess.run,
) -> str:
    command = build_update_command(
        repo_root.resolve(),
        repo=args.repo,
        ref=args.ref,
        skip_venv=args.skip_venv,
    )
    warning = _warning()
    if args.dry_run:
        return "\n".join([warning, "Dry run. Command:", command])

    completed = runner(
        command,
        cwd=repo_root,
        shell=True,
        text=True,
        capture_output=True,
        check=False,
    )
    output = "\n".join(
        part.strip()
        for part in (completed.stdout, completed.stderr)
        if part and part.strip()
    )
    if completed.returncode != 0:
        raise ValueError(
            "harness update failed"
            + (f":\n{output}" if output else f" with exit code {completed.returncode}")
        )
    return "\n".join([warning, output, "harness-codex update completed."]).strip()


def build_update_command(
    repo_root: Path,
    *,
    repo: str = DEFAULT_REPO,
    ref: str = DEFAULT_REF,
    skip_venv: bool = False,
) -> str:
    installer_url = _installer_url(repo, ref)
    parts = [
        "curl",
        "-fsSL",
        shlex.quote(installer_url),
        "|",
        "bash",
        "-s",
        "--",
        "--force",
        "--target",
        shlex.quote(str(repo_root)),
        "--ref",
        shlex.quote(ref),
    ]
    if skip_venv:
        parts.append("--skip-venv")
    return " ".join(parts)


def _installer_url(repo: str, ref: str) -> str:
    text = repo.rstrip("/")
    if text.endswith(".git"):
        text = text[:-4]
    prefix = "https://github.com/"
    if not text.startswith(prefix):
        raise ValueError("--repo must be a https://github.com/<owner>/<repo> URL")
    owner_repo = text[len(prefix) :]
    if owner_repo.count("/") != 1:
        raise ValueError("--repo must be a https://github.com/<owner>/<repo> URL")
    return f"https://raw.githubusercontent.com/{owner_repo}/{ref}/{INSTALLER_PATH}"


def _warning() -> str:
    return (
        "Update will refresh runtime-managed files but preserves workflow-generated "
        "artifacts: .harness runs/sessions/state, ChangeSets, work-item docs, plans, "
        "harvested docs, and project-local config."
    )


if __name__ == "__main__":
    raise SystemExit(main())
