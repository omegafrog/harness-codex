"""Retired legacy state bridge.

Automatic migration from scoped JSON sessions or the ChangeSet Markdown
procedure table is intentionally disabled.  Procedure gates must read only the
canonical ChangeSet XML document.  Historical migration, when required, must
be an explicit operator action that writes validated XML state before resume.
"""

from __future__ import annotations

_PATCHED = "_harness_dashboard_runtime_legacy_bridge_applied"


def apply_dashboard_runtime_state_legacy_bridge() -> None:
    """Keep the compatibility import stable without registering state readers."""

    from harness_codex.runtime import dashboard_runtime_state as canonical

    setattr(canonical, _PATCHED, True)
