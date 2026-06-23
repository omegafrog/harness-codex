"""Runtime support package for harness-codex."""

from __future__ import annotations

from importlib import import_module

__all__ = ["__version__"]

__version__ = "0.1.134"


def _install_changeset_execution_boundary() -> None:
    """Route the CLI hook through the two-layer ChangeSet session orchestrator.

    The public parser and injected test doubles stay stable while execution moves
    from one mixed workflow to explicit work-item and finalization boundaries.
    """

    cli = import_module("harness_codex.cli")
    if getattr(cli, "_changeset_execution_boundary_installed", False):
        return

    from harness_codex.runtime.changeset_orchestrator import apply_workflow

    def run_session(*args, **kwargs):
        return apply_workflow(
            *args,
            **kwargs,
            workflow_loader=cli.load_named_workflow,
            workflow_materializer=cli.materialize_workflow_for_scope,
            manifest_writer=cli.write_materialized_workflow_manifest,
            engine_factory=lambda: cli.RunnerEngine(cli.BasicStepRunner()),
            emit=print,
        )

    cli._apply_workflow = run_session
    cli._changeset_execution_boundary_installed = True


_install_changeset_execution_boundary()
