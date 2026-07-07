"""Retired compatibility hook for legacy dashboard sessions.

The XML state cutover does not inspect old JSON sessions.  A historical
ChangeSet must be migrated explicitly rather than changing gate semantics at
runtime.
"""

from __future__ import annotations

_PATCHED = "_harness_dashboard_runtime_legacy_language_compat_applied"


def apply_dashboard_runtime_state_legacy_compat() -> None:
    """Retain the import surface without registering legacy JSON readers."""

    from harness_codex.runtime import dashboard_runtime_state_legacy_bridge as bridge

    setattr(bridge, _PATCHED, True)
