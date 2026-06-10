import json
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.app_runner import APP_RUN_SCRIPT, run_app


def test_run_app_requires_versioned_script(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="app run script not found"):
        run_app(tmp_path)


def test_run_app_executes_from_repo_root_and_forwards_args(tmp_path: Path) -> None:
    script = tmp_path / APP_RUN_SCRIPT
    script.parent.mkdir(parents=True)
    script.write_text(
        """#!/bin/sh
python3 - "$@" <<'PY'
import json
import pathlib
import sys

pathlib.Path("app-run.json").write_text(
    json.dumps({"cwd": str(pathlib.Path.cwd()), "args": sys.argv[1:]}),
    encoding="utf-8",
)
PY
exit 7
""",
        encoding="utf-8",
    )
    assert run_app(tmp_path, ("--profile", "local")) == 7
    result = json.loads((tmp_path / "app-run.json").read_text(encoding="utf-8"))
    assert result == {
        "cwd": str(tmp_path.resolve()),
        "args": ["--profile", "local"],
    }


def test_run_app_returns_130_when_interrupted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = tmp_path / APP_RUN_SCRIPT
    script.parent.mkdir(parents=True)
    script.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(subprocess, "run", interrupt)

    assert run_app(tmp_path) == 130
