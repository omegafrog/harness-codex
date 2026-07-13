import subprocess
from pathlib import Path

from harness_codex.runtime.self_update import build_update_command


def test_installer_script_uses_single_source_package() -> None:
    script = Path("scripts/install-harness-codex.sh").read_text(encoding="utf-8")

    assert 'for path in harness_codex completions .codex harness;' in script
    assert '.harness/runtime' in script


def test_installer_script_is_valid_bash() -> None:
    completed = subprocess.run(
        ["bash", "-n", "scripts/install-harness-codex.sh"],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


def test_self_update_prefers_project_installer(tmp_path: Path) -> None:
    runtime_installer = tmp_path / "scripts/install-harness-codex.sh"
    runtime_installer.parent.mkdir(parents=True)
    runtime_installer.write_text("#!/usr/bin/env bash\n", encoding="utf-8")

    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex")

    assert str(runtime_installer) in command
    assert "scripts/install-harness-codex.sh" in command


def test_self_update_falls_back_to_download_without_local_installer(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex")

    assert "curl -fsSL" in command
    assert "/scripts/install-harness-codex.sh" in command
