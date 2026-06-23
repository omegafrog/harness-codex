"""Compatibility rule for legacy preflight callers without a work-item scope."""

from __future__ import annotations


def apply_preflight_policy_patch() -> None:
    """Keep legacy preflight invocations strict until scope is supplied.

    The policy matrix is intentionally work-item scoped. Older callers that pass
    no scope cannot prove a gate is irrelevant, so their environment and baseline
    checks remain required rather than being treated as skipped.
    """

    import harness_codex.runtime.preflight as preflight_module
    from harness_codex.runtime.gate_policy import GateRequirement

    if getattr(preflight_module, "_empty_scope_policy_patch_applied", False):
        return

    original_gate_requirement = preflight_module._gate_requirement

    def gate_requirement(policies, gate_id):
        if not policies:
            return GateRequirement.REQUIRED
        return original_gate_requirement(policies, gate_id)

    preflight_module._gate_requirement = gate_requirement
    preflight_module._empty_scope_policy_patch_applied = True
