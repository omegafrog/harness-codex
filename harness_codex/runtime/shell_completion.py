"""Shell completion candidate and install helpers for the harness CLI."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime.changes import ChangeSet, ChangeSetResolver, NoActiveChangeSetsError


@dataclass(frozen=True)
class CompletionCandidate:
    """One shell completion candidate with an optional display description."""

    value: str
    description: str = ""


@dataclass(frozen=True)
class CompletionInstallResult:
    """Installed completion file path and user-facing follow-up note."""

    shell: str
    source: Path
    target: Path
    note: str


def change_set_candidates(repo_root: Path | str, prefix: str = "") -> tuple[CompletionCandidate, ...]:
    """Return active ChangeSet IDs for current staged workflow completion."""

    return change_set_candidates(repo_root, prefix, scope="active")


def change_set_candidates(
    repo_root: Path | str,
    prefix: str = "",
    *,
    scope: str = "all",
) -> tuple[CompletionCandidate, ...]:
    """Return ChangeSet IDs with status/title descriptions."""

    normalized_prefix = prefix.strip()
    resolver = ChangeSetResolver(Path(repo_root))
    change_sets: list[ChangeSet] = []
    if scope in ("active", "all"):
        try:
            change_sets.extend(resolver.list_active())
        except NoActiveChangeSetsError:
            pass
    if scope in ("completed", "all"):
        completed_dir = Path(repo_root) / "docs/changes/completed"
        for path in sorted(completed_dir.glob("*.md")):
            change_sets.append(resolver.load(path))

    return tuple(
        CompletionCandidate(
            change_set.change_set_id,
            _change_set_description(change_set),
        )
        for change_set in change_sets
        if not normalized_prefix or change_set.change_set_id.startswith(normalized_prefix)
    )


def _change_set_description(change_set: ChangeSet) -> str:
    status = change_set.status or "-"
    title = change_set.title or change_set.intent_summary or "-"
    return f"{status} - {title}"


def format_candidates(
    candidates: Iterable[CompletionCandidate],
    *,
    shell_format: str,
) -> str:
    """Format candidates for completion scripts."""

    if shell_format == "zsh":
        return "\n".join(
            f"{candidate.value}:{_zsh_description(candidate.description)}"
            for candidate in candidates
        )
    if shell_format == "bash":
        return "\n".join(candidate.value for candidate in candidates)
    if shell_format == "tsv":
        return "\n".join(
            f"{candidate.value}\t{candidate.description}" for candidate in candidates
        )
    raise ValueError(f"unsupported completion format: {shell_format}")


def install_completion(
    repo_root: Path | str,
    *,
    shell: str = "auto",
    home: Path | None = None,
) -> tuple[CompletionInstallResult, ...]:
    """Install bundled shell completion files into the user's home directory."""

    root = Path(repo_root)
    selected = _detect_shell(shell)
    install_home = home or Path.home()
    if selected == "zsh":
        return (_install_zsh_completion(root, install_home),)
    if selected == "bash":
        return (_install_bash_completion(root, install_home),)
    if selected == "all":
        return (
            _install_zsh_completion(root, install_home),
            _install_bash_completion(root, install_home),
        )
    raise ValueError(f"unsupported shell for completion install: {shell}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m harness_codex.runtime.shell_completion")
    subparsers = parser.add_subparsers(required=True)

    change_set = subparsers.add_parser("change-set")
    change_set.add_argument("--repo-root", default=".")
    change_set.add_argument("--prefix", default="")
    change_set.add_argument(
        "--format",
        choices=("bash", "zsh", "tsv"),
        default="tsv",
    )
    change_set.set_defaults(func=change_set_completion_command)

    change_set = subparsers.add_parser("change-set")
    change_set.add_argument("--repo-root", default=".")
    change_set.add_argument("--prefix", default="")
    change_set.add_argument("--scope", choices=("active", "completed", "all"), default="all")
    change_set.add_argument(
        "--format",
        choices=("bash", "zsh", "tsv"),
        default="tsv",
    )
    change_set.set_defaults(func=change_set_completion_command)

    install = subparsers.add_parser("install")
    install.add_argument("--repo-root", default=".")
    install.add_argument("--shell", choices=("auto", "zsh", "bash", "all"), default="auto")
    install.set_defaults(func=install_completion_command)
    return parser


def change_set_completion_command(args: argparse.Namespace) -> str:
    return format_candidates(
        change_set_candidates(args.repo_root, args.prefix),
        shell_format=args.format,
    )


def change_set_completion_command(args: argparse.Namespace) -> str:
    return format_candidates(
        change_set_candidates(args.repo_root, args.prefix, scope=args.scope),
        shell_format=args.format,
    )


def install_completion_command(args: argparse.Namespace) -> str:
    results = install_completion(args.repo_root, shell=args.shell)
    lines = ["Installed harness shell completion:"]
    for result in results:
        lines.append(f"- {result.shell}: {result.source} -> {result.target}")
        lines.append(f"  {result.note}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output = args.func(args)
    if output:
        print(output)
    return 0


def _install_zsh_completion(repo_root: Path, home: Path) -> CompletionInstallResult:
    source = repo_root / "completions" / "_harness"
    if not source.exists():
        raise ValueError(f"completion source file not found: {source}")
    target_dir = home / ".zfunc"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "_harness"
    shutil.copyfile(source, target)
    return CompletionInstallResult(
        shell="zsh",
        source=source,
        target=target,
        note="Ensure `fpath=(~/.zfunc $fpath)` and `autoload -Uz compinit && compinit` are loaded in your zsh session.",
    )


def _install_bash_completion(repo_root: Path, home: Path) -> CompletionInstallResult:
    source = repo_root / "completions" / "harness.bash"
    if not source.exists():
        raise ValueError(f"completion source file not found: {source}")
    target_dir = home / ".local/share/bash-completion/completions"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "harness"
    shutil.copyfile(source, target)
    return CompletionInstallResult(
        shell="bash",
        source=source,
        target=target,
        note="Start a new bash session or source the installed completion file to use it immediately.",
    )


def _detect_shell(value: str) -> str:
    if value != "auto":
        return value
    shell_name = Path(os.environ.get("SHELL", "")).name
    if shell_name in {"zsh", "bash"}:
        return shell_name
    return "zsh"


def _zsh_description(value: str) -> str:
    return value.replace(":", " -") if value else "-"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
