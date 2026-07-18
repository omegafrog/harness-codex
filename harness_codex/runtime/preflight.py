"""Deprecated import shim for legacy repository-aware preflight."""

from warnings import warn

warn(
    "harness_codex.runtime.preflight is a two-release compatibility shim; "
    "declare ProbeRequest objects through contract_evidence instead",
    DeprecationWarning,
    stacklevel=2,
)

from harness_codex.compat import workflow_preflight as _legacy  # noqa: E402
from harness_codex.compat.workflow_preflight import *  # noqa: F401,F403,E402

# Private aliases are retained only for the two-release compatibility tests.
shutil = _legacy.shutil
_tool_reference_text = _legacy._tool_reference_text
_gate_requirement = _legacy._gate_requirement


def _required_tool_checks(repo_root, policies):
    original = _legacy._tool_reference_text
    _legacy._tool_reference_text = _tool_reference_text
    try:
        return _legacy._required_tool_checks(repo_root, policies)
    finally:
        _legacy._tool_reference_text = original
