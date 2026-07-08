"""Self-update helper for installed harness-codex runtimes."""

from __future__ import annotations

import argparse
import ast
import shlex
import subprocess
from pathlib import Path
from collections.abc import Callable, Sequence
from typing import Protocol

from harness_codex import __version__
from harness_codex.runtime.shell_completion import CompletionInstallResult, install_completion

DEFAULT_REPO = "https://github.com/omegafrog/harness-codex"
DEFAULT_REF = "origin/main"
INSTALLER_PATH = "scripts/install-harness-codex.sh"
RUNTIME_DIR = Path(".harness/runtime")
RUNTIME_INSTALLER_PATH = RUNTIME_DIR / "scripts/install-harness-codex.sh"


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
            "Update refreshes runtime-managed files from origin/main by default "
            "while preserving workflow-generated artifacts such as runs, sessions, "
            "ChangeSets, plans, harvested docs, and project-local config."
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
        help=(
            "branch, tag, or commit to install. Defaults to origin/main. "
            "GitHub archive/download URLs normalize origin/<branch> to <branch>."
        ),
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
    completion_installer: Callable[[Path], Sequence[CompletionInstallResult]] = install_completion,
) -> str:
    version_before = _installed_runtime_version(repo_root)
    command = build_update_command(
        repo_root.resolve(),
        repo=args.repo,
        ref=args.ref,
        skip_venv=args.skip_venv,
    )
    warning = _warning(args.repo, args.ref)
    if args.dry_run:
        return "\n".join(
            [warning, f"Installed runtime version: {version_before}", "Dry run. Command:", command]
        )

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
    patch_output = _apply_repository_patches(repo_root, runner=runner)
    version_after = _installed_runtime_version(repo_root)
    completion_results = completion_installer(repo_root)
    completion_lines = ["Installed shell completion:"]
    for result in completion_results:
        completion_lines.append(f"- {result.shell}: {result.source} -> {result.target}")
        completion_lines.append(f"  {result.note}")
    return "\n".join(
        [
            warning,
            f"Runtime version: {version_before} -> {version_after}",
            output,
            patch_output,
            "\n".join(completion_lines),
            "harness-codex update completed.",
        ]
    ).strip()


def build_update_command(
    repo_root: Path,
    *,
    repo: str = DEFAULT_REPO,
    ref: str = DEFAULT_REF,
    skip_venv: bool = False,
) -> str:
    install_ref = _downloadable_ref(ref)
    local_installer = _local_installer(repo_root)
    if local_installer.exists():
        parts = [
            f"HARNESS_CODEX_REPO={shlex.quote(repo)}",
            "bash",
            shlex.quote(str(local_installer)),
        ]
    else:
        installer_url = _installer_url(repo, install_ref)
        parts = [
            f"HARNESS_CODEX_REPO={shlex.quote(repo)}",
            "curl",
            "-fsSL",
            shlex.quote(installer_url),
            "|",
            "bash",
            "-s",
            "--",
        ]
    parts.extend(
        [
            "--runtime",
            "--force",
            "--target",
            shlex.quote(str(repo_root)),
            "--ref",
            shlex.quote(install_ref),
        ]
    )
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


def _local_installer(repo_root: Path) -> Path:
    runtime_installer = repo_root / RUNTIME_INSTALLER_PATH
    if runtime_installer.exists():
        return runtime_installer
    return repo_root / INSTALLER_PATH


def _downloadable_ref(ref: str) -> str:
    """Convert a local remote-tracking ref label into a GitHub-downloadable ref."""

    normalized = ref.strip()
    if not normalized:
        raise ValueError("--ref must not be empty")
    if normalized.startswith("refs/remotes/origin/"):
        return normalized.removeprefix("refs/remotes/origin/")
    if normalized.startswith("origin/"):
        return normalized.removeprefix("origin/")
    return normalized


def _warning(repo: str, ref: str) -> str:
    install_ref = _downloadable_ref(ref)
    source = f"{repo.rstrip('/')}@{ref}"
    if install_ref != ref:
        source = f"{source} (download ref: {install_ref})"
    return (
        f"Update source: {source}\n"
        "Update will refresh runtime-managed files but preserves workflow-generated "
        "artifacts: .harness runs/sessions/state/evolution/ui, .harness/docs/agent, ChangeSets, "
        "work-item docs, plans, harvested docs, and project-local config. "
        "Runtime docs and templates under .harness/docs are refreshed. "
        "After a successful installer run, "
        "update installs shell completion for the detected shell."
    )


def _apply_repository_patches(repo_root: Path, *, runner: Runner = subprocess.run) -> str:
    python_bin = repo_root / "venv" / "bin" / "python3"
    runtime_dir = repo_root / RUNTIME_DIR
    command = [
        str(python_bin) if python_bin.exists() else "python3",
        "-m",
        "harness_codex.runtime.repository_patches",
        "--repo-root",
        str(repo_root),
    ]
    completed = runner(
        command,
        cwd=repo_root,
        env=_pythonpath_env(runtime_dir),
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
            "harness update repository patch failed"
            + (f":\n{output}" if output else f" with exit code {completed.returncode}")
        )
    return "Repository patches: " + (output or "no output")


def _installed_runtime_version(repo_root: Path) -> str:
    init_file = repo_root / RUNTIME_DIR / "harness_codex" / "__init__.py"
    if not init_file.exists():
        init_file = repo_root / "harness_codex" / "__init__.py"
    if not init_file.exists():
        return __version__
    try:
        tree = ast.parse(init_file.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return "unknown"
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
            continue
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return node.value.value
    return "unknown"


def _pythonpath_env(runtime_dir: Path) -> dict[str, str] | None:
    if not runtime_dir.exists():
        return None
    import os

    env = os.environ.copy()
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(runtime_dir) + ((f":{existing}") if existing else "")
    return env


if __name__ == "__main__":
    raise SystemExit(main())
