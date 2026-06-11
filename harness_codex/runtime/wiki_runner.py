"""Run repository-local MkDocs wiki contracts."""

from __future__ import annotations

import subprocess
from pathlib import Path

WIKI_BUILD_SCRIPT = Path("scripts/build-wiki.sh")
WIKI_SERVE_SCRIPT = Path("scripts/serve-wiki.sh")
WIKI_REQUIREMENTS = Path("docs/wiki/requirements.txt")
VENV_PYTHON = Path("venv/bin/python3")


def run_wiki(
    repo_root: Path | str,
    action: str = "serve",
    *,
    dev_addr: str = "127.0.0.1:8000",
) -> int:
    root = Path(repo_root).resolve()

    if action == "build":
        return _run_script(root, WIKI_BUILD_SCRIPT)
    if action == "serve":
        return _run_script(root, WIKI_SERVE_SCRIPT, ("--dev-addr", dev_addr))
    if action == "install":
        python = _require_file(root, VENV_PYTHON, "repository venv Python")
        requirements = _require_file(root, WIKI_REQUIREMENTS, "wiki requirements")
        return _run(
            [str(python), "-m", "pip", "install", "-r", str(requirements)],
            root,
        )
    raise ValueError(f"unsupported wiki action: {action}")


def _run_script(root: Path, relative_path: Path, args: tuple[str, ...] = ()) -> int:
    script = _require_file(root, relative_path, "wiki script")
    return _run(["sh", str(script), *args], root)


def _run(command: list[str], root: Path) -> int:
    try:
        completed = subprocess.run(command, cwd=root, check=False)
    except KeyboardInterrupt:
        return 130
    return completed.returncode


def _require_file(root: Path, relative_path: Path, label: str) -> Path:
    path = root / relative_path
    if not path.is_file():
        raise ValueError(f"{label} not found: {relative_path}")
    return path
