"""Runtime support package for harness-codex."""

from __future__ import annotations

from importlib import import_module

__all__ = ["__version__"]

__version__ = "0.1.129"


def _install_cli_materializer_compatibility() -> None:
    """Accept pre-run-id materializer extensions during the transition period."""

    cli = import_module("harness_codex.cli")
    if getattr(cli, "_materializer_run_id_compatibility_installed", False):
        return

    original_apply_workflow = cli._apply_workflow

    def apply_workflow(*args, **kwargs):
        materializer = cli.materialize_workflow_for_scope

        def materialize_with_compatibility(*materializer_args, **materializer_kwargs):
            try:
                return materializer(*materializer_args, **materializer_kwargs)
            except TypeError as exc:
                if "run_id" not in materializer_kwargs or "unexpected keyword argument" not in str(exc):
                    raise
                return materializer(*materializer_args)

        cli.materialize_workflow_for_scope = materialize_with_compatibility
        try:
            return original_apply_workflow(*args, **kwargs)
        finally:
            cli.materialize_workflow_for_scope = materializer

    cli._apply_workflow = apply_workflow
    cli._materializer_run_id_compatibility_installed = True


_install_cli_materializer_compatibility()
