import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "bump_runtime_version.py"


def test_bump_runtime_version_increases_patch_version(tmp_path: Path) -> None:
    version_file = tmp_path / "__init__.py"
    version_file.write_text('__all__ = ["__version__"]\n\n__version__ = "0.1.1"\n', encoding="utf-8")

    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--file", str(version_file)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout.strip() == "0.1.1 -> 0.1.2"
    assert '__version__ = "0.1.2"' in version_file.read_text(encoding="utf-8")


def test_bump_runtime_version_rejects_non_semantic_version(tmp_path: Path) -> None:
    version_file = tmp_path / "__init__.py"
    version_file.write_text('__version__ = "dev"\n', encoding="utf-8")

    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--file", str(version_file)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "expected exactly one semantic __version__ assignment" in completed.stderr
    assert version_file.read_text(encoding="utf-8") == '__version__ = "dev"\n'
