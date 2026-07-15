"""harness-codex package metadata.

Runtime extensions are configured explicitly by ``harness_codex.bootstrap`` at
an executable entry point. Importing this package must not replace runtime
methods, start observers, or mutate CLI handlers.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.178"
