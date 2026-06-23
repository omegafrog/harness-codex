"""Work-item gate selection and final changed-file reconciliation.

The initial gate plan comes from the approved ChangeSet work-item type and impact.
`affected-files.md` is a planning and scope contract, not an input that can weaken
that initial decision.  After implementation, actual changed paths are checked for
signals that require a gate which the initial policy skipped.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable

from harness_codex.runtime.changes.models import PlanningInputScope, WorkItemType


class GateRequirement(str, Enum):
    """How a gate participates in the current work-item run."""

    REQUIRED = "required"
    CONDITIONAL = "conditional"
    OPTIONAL = "optional"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class GateDecision:
    """One applied, deferred, or skipped gate with its audit reason."""

    gate_id: str
    requirement: GateRequirement
    reason: str
    waiver_allowed: bool = False

    @property
    def applies(self) -> bool:
        return self.requirement is not GateRequirement.SKIPPED

    @property
    def blocking(self) -> bool:
        return self.requirement is GateRequirement.REQUIRED

    def as_dict(self) -> dict[str, object]:
        return {
            "gate_id": self.gate_id,
            "requirement": self.requirement.value,
            "reason": self.reason,
            "waiver_allowed": self.waiver_allowed,
            "blocking": self.blocking,
        }


@dataclass(frozen=True)
class GatePolicy:
    """Policy evaluated for a single ChangeSet work item."""

    work_item_id: str
    work_item_type: WorkItemType
    impact_type: str
    risk_level: str
    decisions: tuple[GateDecision, ...]

    def decision_for(self, gate_id: str) -> GateDecision:
        for decision in self.decisions:
            if decision.gate_id == gate_id:
                return decision
        return GateDecision(
            gate_id=gate_id,
            requirement=GateRequirement.OPTIONAL,
            reason="The workflow does not declare this gate in the policy matrix.",
            waiver_allowed=True,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "work_item_id": self.work_item_id,
            "work_item_type": self.work_item_type.value,
            "impact_type": self.impact_type,
            "risk_level": self.risk_level,
            "gates": [decision.as_dict() for decision in self.decisions],
        }


@dataclass(frozen=True)
class GateEscalation:
    """A final diff shows that a previously skipped gate is needed."""

    gate_id: str
    reason: str
    observed_paths: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "gate_id": self.gate_id,
            "reason": self.reason,
            "observed_paths": list(self.observed_paths),
        }


def derive_gate_policy(
    *,
    work_item_id: str,
    work_item_type: WorkItemType,
    impact_type: str = "",
    affected_paths: Iterable[str | Path] = (),
) -> GatePolicy:
    """Derive the initial policy from approved ChangeSet metadata.

    ``affected_paths`` remains an accepted argument for backwards compatibility, but
    is deliberately ignored here.  It is written during planning and must not be
    able to reduce checks selected from the approved work-item impact.
    """

    del affected_paths
    impact = impact_type.casefold()
    docs_only = _has_marker(impact, "documentation", "docs-only", "docs only", "document-only", "document only")
    ui = _has_marker(impact, "ui", "frontend", "browser")
    security = _has_marker(impact, "security", "auth", "permission", "payment", "privacy", "token", "crypto")
    external = ui or security or _has_marker(impact, "api", "public", "external", "user")
    source_change = not docs_only

    risk_level = (
        "security-sensitive"
        if security
        else "ui"
        if ui
        else "feature"
        if work_item_type in {WorkItemType.USE_CASE, WorkItemType.FEATURE_EXTENSION} or external
        else "documentation"
        if docs_only
        else "maintenance"
    )

    decisions: list[GateDecision] = [
        _required("scope-contract", "ChangeSet scope and selected work item must match."),
        _required("placeholder-resolution", "Planning scope declarations must not contain placeholders."),
        _required("verification-evidence", "The completed plan must retain verification evidence."),
        _required("out-of-scope-detection", "Changes outside the declared work-item scope must be blocked."),
        _required("plan-review", "The implementation plan requires a review record before execution."),
        _required("verification", "Every work item requires executable or documented verification evidence."),
    ]

    if security:
        decisions.append(_required("security-review", "Declared security impact requires independent security review."))
        decisions.append(_required("static-analysis", "Declared security impact requires static-analysis evidence."))
    elif docs_only:
        decisions.append(_skipped("security-review", "Declared documentation-only work has no security-relevant code path."))
        decisions.append(_skipped("static-analysis", "Declared documentation-only work has no source code to analyse."))
    elif external:
        decisions.append(_conditional("security-review", "Declared external behavior may require security review."))
        decisions.append(_conditional("static-analysis", "Declared source behavior may require repository static analysis."))
    elif source_change or work_item_type is not WorkItemType.MAINTENANCE:
        decisions.append(_conditional("security-review", "No security-sensitive impact was declared for this source change."))
        decisions.append(_conditional("static-analysis", "Static analysis is applicable when the repository declares it."))
    else:
        decisions.append(_skipped("security-review", "No source or external impact was declared."))
        decisions.append(_skipped("static-analysis", "No source-analysis requirement was declared."))

    if ui:
        decisions.append(_required("browser-ui", "Declared UI impact requires browser-visible verification."))
        decisions.append(_required("runtime-server", "Declared UI impact requires runnable runtime evidence."))
    else:
        decisions.append(_skipped("browser-ui", "No UI impact was declared in the ChangeSet."))
        if work_item_type is WorkItemType.USE_CASE and not docs_only:
            decisions.append(_conditional("runtime-server", "Use-case runtime verification is required only when the goal needs a live service."))
        else:
            decisions.append(_skipped("runtime-server", "No UI or live-runtime impact was declared."))

    if work_item_type is WorkItemType.USE_CASE and not docs_only:
        decisions.append(_required("full-e2e", "Use-case behavior must satisfy its E2E goal."))
        decisions.append(_required("test-gate", "Use-case completion requires the repository test gate."))
    elif docs_only:
        decisions.append(_skipped("full-e2e", "Declared documentation-only work has no product E2E behavior."))
        decisions.append(_skipped("test-gate", "Declared documentation-only work uses document evidence instead of application tests."))
    elif source_change:
        decisions.append(_conditional("full-e2e", "Source changes need E2E only when the verification goal declares it."))
        decisions.append(_conditional("test-gate", "Source changes run the project gate when applicable."))
    else:
        decisions.append(_skipped("full-e2e", "The declared work item has no product behavior."))
        decisions.append(_conditional("test-gate", "A narrow verification command may be used when declared by the work item."))

    return GatePolicy(
        work_item_id=work_item_id,
        work_item_type=work_item_type,
        impact_type=impact_type,
        risk_level=risk_level,
        decisions=tuple(decisions),
    )


def derive_gate_policy_for_scope(
    repo_root: Path | str,
    scope: PlanningInputScope,
    *,
    impact_type: str | None = None,
) -> GatePolicy:
    """Derive a policy from resolved scope metadata, never from planned file paths."""

    del repo_root
    resolved_impact = impact_type
    if resolved_impact is None:
        resolved_impact = scope.impact_type or (scope.use_case.impact_type if scope.use_case else "")
    return derive_gate_policy(
        work_item_id=scope.display_id,
        work_item_type=scope.work_item_type,
        impact_type=resolved_impact,
    )


def reconcile_observed_change_gates(
    policies: Iterable[GatePolicy],
    changed_paths: Iterable[str | Path],
) -> tuple[GateEscalation, ...]:
    """Return gates that final changed files require but the plan skipped.

    This is a safety check, not a second source of initial policy.  A UI, security,
    or source-code path that appears after implementation cannot silently keep its
    required verification skipped; the ChangeSet must be corrected and verification
    rerun before delivery.
    """

    policy_list = tuple(policies)
    if not policy_list:
        return ()
    paths = tuple(dict.fromkeys(_normalize_path(path) for path in changed_paths if str(path).strip()))
    if not paths:
        return ()

    observations: list[tuple[str, str, tuple[str, ...]]] = []
    ui_paths = tuple(path for path in paths if _is_ui_path(path))
    if ui_paths:
        observations.extend(
            (
                ("browser-ui", "Actual changed files include UI paths, but the planned browser check was skipped.", ui_paths),
                ("runtime-server", "Actual changed files include UI paths, but the planned runtime check was skipped.", ui_paths),
            )
        )
    security_paths = tuple(path for path in paths if _is_security_path(path))
    if security_paths:
        observations.extend(
            (
                ("security-review", "Actual changed files include security-sensitive paths, but security review was skipped.", security_paths),
                ("static-analysis", "Actual changed files include security-sensitive paths, but static analysis was skipped.", security_paths),
            )
        )
    source_paths = tuple(path for path in paths if not _is_document_path(path))
    if source_paths:
        observations.append(
            ("test-gate", "Actual changed files include source code, but the planned test gate was skipped.", source_paths)
        )

    escalations: list[GateEscalation] = []
    for gate_id, reason, observed_paths in observations:
        if _combined_requirement(policy_list, gate_id) is GateRequirement.SKIPPED:
            escalations.append(GateEscalation(gate_id, reason, observed_paths))
    return tuple(escalations)


def _combined_requirement(policies: tuple[GatePolicy, ...], gate_id: str) -> GateRequirement:
    requirements = {policy.decision_for(gate_id).requirement for policy in policies}
    if GateRequirement.REQUIRED in requirements:
        return GateRequirement.REQUIRED
    if GateRequirement.CONDITIONAL in requirements:
        return GateRequirement.CONDITIONAL
    if GateRequirement.OPTIONAL in requirements:
        return GateRequirement.OPTIONAL
    return GateRequirement.SKIPPED


def _has_marker(value: str, *markers: str) -> bool:
    return any(marker in value for marker in markers)


def _normalize_path(value: str | Path) -> str:
    return str(value).strip().lower().replace("\\", "/")


def _is_document_path(path: str) -> bool:
    return path.startswith("docs/") or path in {"readme.md", "changelog.md"} or path.endswith(".md")


def _is_ui_path(path: str) -> bool:
    return path.endswith((".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss")) or any(
        segment in path for segment in ("/frontend/", "/ui/", "/web/", "/templates/", "/static/")
    )


def _is_security_path(path: str) -> bool:
    return any(
        marker in path
        for marker in ("auth", "security", "permission", "oauth", "token", "crypto", "secret", "payment", "billing")
    )


def _required(gate_id: str, reason: str) -> GateDecision:
    return GateDecision(gate_id, GateRequirement.REQUIRED, reason, waiver_allowed=False)


def _conditional(gate_id: str, reason: str) -> GateDecision:
    return GateDecision(gate_id, GateRequirement.CONDITIONAL, reason, waiver_allowed=True)


def _skipped(gate_id: str, reason: str) -> GateDecision:
    return GateDecision(gate_id, GateRequirement.SKIPPED, reason, waiver_allowed=False)
