from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen


def _available_port() -> int:
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def _wait_for_dashboard(port: int, expected_pid_path: Path, expected_pid: int) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            current_pid = int(expected_pid_path.read_text(encoding="utf-8").strip())
            with urlopen(f"http://127.0.0.1:{port}/api/dashboard", timeout=0.2) as response:
                if current_pid == expected_pid and response.status == 200:
                    return
        except (FileNotFoundError, OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("UI server did not become ready")


def _start_server(repo_root: Path, port: int) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "harness_codex",
            "--repo-root",
            str(repo_root),
            "ui-server",
            "--port",
            str(port),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def test_ui_server_restarts_existing_server_for_repo(tmp_path: Path) -> None:
    port = _available_port()
    pid_path = tmp_path / ".harness" / "ui-server.pid"
    first = _start_server(tmp_path, port)
    second: subprocess.Popen[bytes] | None = None
    try:
        _wait_for_dashboard(port, pid_path, first.pid)

        second = _start_server(tmp_path, port)
        _wait_for_dashboard(port, pid_path, second.pid)

        assert first.wait(timeout=2) == 0
    finally:
        if second is not None and second.poll() is None:
            second.terminate()
            second.wait(timeout=2)
            assert not pid_path.exists()
        if first.poll() is None:
            first.terminate()
            first.wait(timeout=2)
