from pathlib import Path
import subprocess


SCRIPT_PATH = Path("install.sh")
SCRIPT = SCRIPT_PATH.read_text(encoding="utf-8")


def test_root_installer_has_valid_bash_syntax() -> None:
    completed = subprocess.run(
        ["bash", "-n", str(SCRIPT_PATH)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr


def test_root_installer_installs_runtime_then_generates_docs() -> None:
    install_index = SCRIPT.index('bash "$TMP_DIR/install-harness-codex.sh"')
    init_index = SCRIPT.index('"$TARGET_DIR/harness" init')

    assert install_index < init_index
    assert "--runtime" in SCRIPT
    assert '--target "$TARGET_DIR"' in SCRIPT
    assert 'INSTALLER_ARGS+=("--force")' in SCRIPT
    assert 'echo "Unsupported option: $1"' in SCRIPT
    assert "Bootstrap never implements product code." in SCRIPT
