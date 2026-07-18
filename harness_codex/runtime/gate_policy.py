"""Deprecated import shim for caller-owned legacy gate policy."""

from warnings import warn

warn(
    "harness_codex.runtime.gate_policy is a two-release compatibility shim; "
    "declare opaque requirements through contract_evidence instead",
    DeprecationWarning,
    stacklevel=2,
)

from harness_codex.compat.gate_policy import *  # noqa: F401,F403,E402
