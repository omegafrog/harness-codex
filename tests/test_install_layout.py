import subprocess
from pathlib import Path

from harness_codex.runtime.self_update import build_update_command


def test_installer_script_uses_single_runtime_directory() -> None:
    script = Path("scripts/install-harness-codex.sh").read_text(encoding="utf-8")

    assert 'RUNTIME_DIR_REL=".harness/runtime"' in script
    assert '$TARGET_DIR/$RUNTIME_DIR_REL/harness_codex' in script
    assert '$TARGET_DIR/$RUNTIME_DIR_REL/completions' in script
    assert '$TARGET_DIR/$RUNTIME_DIR_REL/scripts/install-harness-codex.sh' in script
    assert 'copy_dir "$SRC_DIR/schemas" "$TARGET_DIR/.harness/schemas"' in script
    assert '".harness/orchestration"' in script
    assert 'PYTHONPATH="$RUNTIME_DIR${PYTHONPATH:+:$PYTHONPATH}"' in script
    assert 'copy_dir "$SRC_DIR/harness_codex" "$TARGET_DIR/harness_codex"' not in script
    assert 'copy_dir "$SRC_DIR/completions" "$TARGET_DIR/completions"' not in script


def test_installer_script_is_valid_bash() -> None:
    completed = subprocess.run(
        ["bash", "-n", "scripts/install-harness-codex.sh"],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


def test_self_update_prefers_runtime_installer(tmp_path: Path) -> None:
    runtime_installer = tmp_path / ".harness/runtime/scripts/install-harness-codex.sh"
    runtime_installer.parent.mkdir(parents=True)
    runtime_installer.write_text("#!/usr/bin/env bash\n", encoding="utf-8")

    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex")

    assert str(runtime_installer) in command
    assert "scripts/install-harness-codex.sh" in command


def test_self_update_falls_back_to_download_without_local_installer(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex")

    assert "curl -fsSL" in command
    assert "/scripts/install-harness-codex.sh" in command
