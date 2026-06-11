import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.wiki_runner import (
    WIKI_BUILD_SCRIPT,
    WIKI_REQUIREMENTS,
    WIKI_SERVE_SCRIPT,
    VENV_PYTHON,
    run_wiki,
)


def _write_script(root: Path, relative_path: Path) -> None:
    script = root / relative_path
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")


def test_run_wiki_requires_build_script(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="wiki script not found"):
        run_wiki(tmp_path, "build")


def test_run_wiki_build_executes_versioned_script(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, WIKI_BUILD_SCRIPT)
    captured: dict[str, object] = {}

    def fake_run(command, *, cwd, check):
        captured.update(command=command, cwd=cwd, check=check)
        return subprocess.CompletedProcess(command, 7)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert run_wiki(tmp_path, "build") == 7
    assert captured == {
        "command": ["sh", str(tmp_path / WIKI_BUILD_SCRIPT)],
        "cwd": tmp_path.resolve(),
        "check": False,
    }


def test_run_wiki_serve_forwards_dev_address(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, WIKI_SERVE_SCRIPT)
    commands: list[list[str]] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda command, **kwargs: commands.append(command)
        or subprocess.CompletedProcess(command, 0),
    )

    assert run_wiki(tmp_path, "serve", dev_addr="127.0.0.1:8765") == 0
    assert commands == [
        [
            "sh",
            str(tmp_path / WIKI_SERVE_SCRIPT),
            "--dev-addr",
            "127.0.0.1:8765",
        ]
    ]


def test_run_wiki_install_uses_root_venv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    python = tmp_path / VENV_PYTHON
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")
    requirements = tmp_path / WIKI_REQUIREMENTS
    requirements.parent.mkdir(parents=True)
    requirements.write_text("mkdocs-material==9.7.6\n", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run(command, *, cwd, check):
        captured.update(command=command, cwd=cwd, check=check)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert run_wiki(tmp_path, "install") == 0
    assert captured["command"] == [
        str(python),
        "-m",
        "pip",
        "install",
        "-r",
        str(requirements),
    ]


def test_run_wiki_returns_130_when_interrupted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, WIKI_BUILD_SCRIPT)
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(KeyboardInterrupt),
    )

    assert run_wiki(tmp_path, "build") == 130
