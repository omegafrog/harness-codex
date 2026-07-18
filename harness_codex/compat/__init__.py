"""Two-release compatibility adapters for repository-aware legacy behavior.

New orchestration must provide caller-owned declarations to generic runtime
utilities. Modules here preserve active legacy runs only.
"""

COMPATIBILITY_WINDOW_RELEASES = 2

__all__ = ["COMPATIBILITY_WINDOW_RELEASES"]
