"""Single explicit runtime installer entrypoint."""

from __future__ import annotations

from pathlib import Path
from threading import Lock

from harness_codex.runtime.runtime_services import RuntimeInstallation, install_runtime_services

_configure_lock = Lock()
_configured = False
_last_installation: RuntimeInstallation | None = None


def configure_runtime(repo_root: Path | str | None = None) -> RuntimeInstallation:
    """Install runtime services without monkey patches or import side effects."""

    global _configured, _last_installation
    if _configured and repo_root is None and _last_installation is not None:
        return _last_installation
    with _configure_lock:
        if _configured and repo_root is None and _last_installation is not None:
            return _last_installation
        installation = install_runtime_services(repo_root)
        if repo_root is None:
            _configured = True
            _last_installation = installation
        return installation
