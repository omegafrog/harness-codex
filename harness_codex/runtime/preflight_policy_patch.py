"""Compatibility rule for legacy preflight callers without a work-item scope."""

from __future__ import annotations

from dataclasses import replace


def apply_preflight_policy_patch() -> None:
    """Keep legacy preflight invocations strict until scope is supplied.

    The policy matrix is intentionally work-item scoped. Older callers that pass
    no scope cannot prove a gate is irrelevant, so their environment and baseline
    checks remain required rather than being treated as skipped. The legacy path
    still exposes its historical explicit-waiver metadata for environment blockers,
    except Docker runtime availability. A missing or unreachable Docker daemon is
    an operator-owned blocker that the agent cannot remediate.
    """

    import harness_codex.runtime.preflight as preflight_module
    from harness_codex.runtime.gate_policy import GateRequirement

    if getattr(preflight_module, "_empty_scope_policy_patch_applied", False):
        return

    original_gate_requirement = preflight_module._gate_requirement
    original_required_tool_checks = preflight_module._required_tool_checks

    def gate_requirement(policies, gate_id):
        if not policies:
            return GateRequirement.REQUIRED
        return original_gate_requirement(policies, gate_id)

    def required_tool_checks(repo_root, policies):
        checks = original_required_tool_checks(repo_root, policies)
        if policies:
            return checks
        return tuple(
            replace(check, override_allowed=True)
            if (
                check.status == "fail"
                and check.severity == "blocking"
                and check.check_id != "required-tool-docker"
            )
            else check
            for check in checks
        )

    preflight_module._gate_requirement = gate_requirement
    preflight_module._required_tool_checks = required_tool_checks
    preflight_module._empty_scope_policy_patch_applied = True
