"""Runtime support package for harness-codex."""

from __future__ import annotations

from importlib import import_module

__all__ = ["__version__"]

__version__ = "0.1.130"


def _install_changeset_execution_boundary() -> None:
    """Install the session orchestrator after the legacy CLI module is loaded.

    The public CLI remains stable while its internal `_apply_workflow` hook delegates
    to a two-layer orchestration module. This removes finalization from each
    work-item loop without duplicating the command parser during the transition.
    """

    cli = import_module("harness_codex.cli")
    if getattr(cli, "_changeset_execution_boundary_installed", False):
        return

    from harness_codex.runtime.changeset_orchestrator import apply_workflow

    cli._apply_workflow = apply_workflow
    cli._changeset_execution_boundary_installed = True


_install_changeset_execution_boundary()
