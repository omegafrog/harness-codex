from pathlib import Path

import pytest

from harness_codex.runtime.app_runner import run_app_lifecycle
from harness_codex.cli import _extract_app_timeout


def _write_script(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body, encoding="utf-8")
    path.chmod(0o755)


def test_lifecycle_env_command_reports_runtime_values(tmp_path: Path) -> None:
    env_file = tmp_path / ".harness/app-runtime/dev.env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("HARNESS_APP_PORT=18080\n", encoding="utf-8")

    output = run_app_lifecycle(tmp_path, ["dev", "env"], timeout=7)

    assert "Application dev runtime environment:" in output
    assert "- .harness/app-runtime/dev.env: present" in output
    assert "- HARNESS_APP_ENV=dev" in output
    assert "- HARNESS_APP_HEALTH_TIMEOUT_SECONDS=7" in output
    assert "- HARNESS_APP_PORT=18080" in output


def test_lifecycle_start_passes_environment_to_scripts(tmp_path: Path) -> None:
    script_dir = tmp_path / "scripts/app/dev"
    _write_script(
        script_dir / "start.sh",
        'printf "%s:%s:%s" "$HARNESS_APP_ENV" "$HARNESS_APP_PORT" "$1" > started.txt\n',
    )
    _write_script(script_dir / "health.sh", "test -f started.txt\n")
    _write_script(script_dir / "stop.sh", "rm -f started.txt\n")
    env_file = tmp_path / ".harness/app-runtime/dev.env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("HARNESS_APP_PORT=18080\n", encoding="utf-8")

    output = run_app_lifecycle(tmp_path, ["dev", "start", "--", "arg1"], timeout=5)

    assert "Application dev runtime started:" in output
    assert (tmp_path / "started.txt").read_text(encoding="utf-8") == "dev:18080:arg1"


def test_lifecycle_missing_script_reports_contract(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as exc:
        run_app_lifecycle(tmp_path, ["prod", "health"])

    message = str(exc.value)
    assert "missing prod health script: scripts/app/prod/health.sh" in message
    assert "Create this script before retrying." in message
    assert "harness run app prod env" in message


def test_app_timeout_option_can_follow_lifecycle_action() -> None:
    args, timeout = _extract_app_timeout(["dev", "env", "--timeout", "3"], 60)

    assert args == ["dev", "env"]
    assert timeout == 3


def test_prod_only_usage_is_rejected_for_dev(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="only for the prod"):
        run_app_lifecycle(tmp_path, ["dev", "usage"])


def test_environment_status_script_takes_priority_when_present(tmp_path: Path) -> None:
    _write_script(tmp_path / "scripts/app/prod/status.sh", 'printf "instance:running"\n')

    output = run_app_lifecycle(tmp_path, ["prod", "status"])

    assert "Application prod status: ok" in output
    assert "instance:running" in output
