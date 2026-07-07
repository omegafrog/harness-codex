"""Align generated ChangeSet documentation with XML state authority."""

from __future__ import annotations

_PATCHED_ATTR = "_harness_xml_changeset_template_patch_applied"


def apply_xml_changeset_template_patch() -> None:
    """Ensure a new ChangeSet never advertises JSON or Markdown as state authority."""

    from harness_codex.runtime import procedure_stages, ui_server

    if getattr(procedure_stages, _PATCHED_ATTR, False):
        return

    original = procedure_stages.render_initial_changeset

    def render_initial_changeset(*, change_set_id: str, title: str, request_summary: str) -> str:
        text = original(
            change_set_id=change_set_id,
            title=title,
            request_summary=request_summary,
        )
        return text.replace(
            "- State source of truth: `.harness/runs/<run-id>/state.json` (`RunState`) is authoritative for runtime stage, gate, artifact acceptance, dirty/downstream state, failure kind, and resume target.",
            "- State source of truth: `.harness/state/changesets/<CHG-ID>/state.xml` is authoritative for runtime stage, gate, artifact acceptance, dirty/downstream state, failure kind, resume target, and UI interaction state.",
        ).replace(
            "- Procedure table role: this table is a durable user-facing mirror of `RunState`; reconcile it before using it for planning or dashboard status.",
            "- Procedure table role: this table provides human-readable procedure structure only. Runtime gates, dashboard status, and resume must read the canonical XML state instead.",
        )

    procedure_stages.render_initial_changeset = render_initial_changeset
    ui_server.render_initial_changeset = render_initial_changeset
    setattr(procedure_stages, _PATCHED_ATTR, True)
