"""Work-item gate selection policy and auditable decisions.

The policy keeps scope and evidence protections fail-closed while making expensive
or environment-dependent gates conditional on the work-item's risk profile.
"""

from __future__ import annotations

import re
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


def derive_gate_policy(
    *,
    work_item_id: str,
    work_item_type: WorkItemType,
    impact_type: str = "",
    affected_paths: Iterable[str | Path] = (),
) -> GatePolicy:
    """Derive the least-broad policy that still preserves relevant evidence.

    Scope, placeholder resolution, and evidence integrity are always required.
    UI, runtime, static-analysis, security, and full E2E gates are selected from
    the work-item type, declared impact, and affected-file paths.
    """

    paths = tuple(_normalize_path(path) for path in affected_paths)
    impact = impact_type.lower()
    docs_only = bool(paths) and all(_is_document_path(path) for path in paths)
    ui = any(_is_ui_path(path) for path in paths) or any(
        marker in impact for marker in ("ui", "frontend", "browser")
    )
    security = any(_is_security_path(path) for path in paths) or any(
        marker in impact for marker in ("security", "auth", "permission", "payment", "privacy")
    )
    external = ui or security or any(
        marker in impact for marker in ("api", "public", "external", "user")
    )
    source_change = bool(paths) and not docs_only

    risk_level = "security-sensitive" if security else "ui" if ui else "feature" if (
        work_item_type in {WorkItemType.USE_CASE, WorkItemType.FEATURE_EXTENSION}
        or external
    ) else "documentation" if docs_only else "maintenance"

    decisions: list[GateDecision] = [
        _required("scope-contract", "ChangeSet scope and selected work item must match."),
        _required("placeholder-resolution", "Concrete affected-file declarations are required."),
        _required("verification-evidence", "The completed plan must retain verification evidence."),
        _required("out-of-scope-detection", "Changes outside the declared work-item scope must be blocked."),
        _required("plan-review", "The implementation plan requires a review record before execution."),
        _required("verification", "Every work item requires executable or documented verification evidence."),
    ]

    if security:
        decisions.append(_required("security-review", "Security-sensitive scope requires independent security review."))
        decisions.append(_required("static-analysis", "Security-sensitive scope requires static-analysis evidence."))
    elif docs_only:
        decisions.append(_skipped("security-review", "Documentation-only scope has no security-relevant code path."))
        decisions.append(_skipped("static-analysis", "Documentation-only scope has no source code to analyse."))
    elif external:
        decisions.append(_conditional("security-review", "Externally exposed behavior may require security review."))
        decisions.append(_conditional("static-analysis", "Source changes may require repository static analysis."))
    elif source_change or work_item_type is not WorkItemType.MAINTENANCE:
        decisions.append(_conditional("security-review", "No security-sensitive marker was declared for this source change."))
        decisions.append(_conditional("static-analysis", "Static analysis is applicable when the repository declares it."))
    else:
        decisions.append(_skipped("security-review", "Maintenance scope has no external or security-sensitive marker."))
        decisions.append(_skipped("static-analysis", "Maintenance scope has no declared source-analysis requirement."))

    if ui:
        decisions.append(_required("browser-ui", "UI-affecting files require browser-visible verification."))
        decisions.append(_required("runtime-server", "UI verification requires a runnable application or equivalent runtime evidence."))
    else:
        decisions.append(_skipped("browser-ui", "No UI-affecting files or UI impact were declared."))
        if work_item_type is WorkItemType.USE_CASE and not docs_only:
            decisions.append(_conditional("runtime-server", "Use-case runtime verification is required only when the goal needs a live service."))
        else:
            decisions.append(_skipped("runtime-server", "This work item has no UI or declared live-runtime verification need."))

    if work_item_type is WorkItemType.USE_CASE and not docs_only:
        decisions.append(_required("full-e2e", "Use-case behavior must satisfy its E2E goal."))
        decisions.append(_required("test-gate", "Use-case completion requires the repository test gate."))
    elif docs_only:
        decisions.append(_skipped("full-e2e", "Documentation-only scope has no product E2E behavior."))
        decisions.append(_skipped("test-gate", "Documentation-only scope uses document evidence instead of application tests."))
    elif source_change:
        decisions.append(_conditional("full-e2e", "Maintenance source changes need E2E only when the verification goal declares it."))
        decisions.append(_conditional("test-gate", "Maintenance source changes run the project gate when applicable."))
    else:
        decisions.append(_skipped("full-e2e", "The maintenance scope does not declare product behavior."))
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
) -> GatePolicy:
    """Derive a policy from a resolved scope and its affected-files declaration."""

    root = Path(repo_root)
    paths = list(_scope_declared_paths(root, scope))
    impact_type = scope.use_case.impact_type if scope.use_case is not None else ""
    return derive_gate_policy(
        work_item_id=scope.display_id,
        work_item_type=scope.work_item_type,
        impact_type=impact_type,
        affected_paths=paths,
    )


def _scope_declared_paths(repo_root: Path, scope: PlanningInputScope) -> tuple[str, ...]:
    declared: list[str] = []
    for relative_path in (*scope.planner_inputs, *scope.executor_inputs):
        path = repo_root / relative_path
        if path.name != "affected-files.md" or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        declared.extend(
            candidate
            for candidate in re.findall(r"`([^`]+)`", text)
            if _looks_like_declared_path(candidate)
        )
    return tuple(dict.fromkeys(declared))


def _looks_like_declared_path(value: str) -> bool:
    normalized = value.strip().replace("\\", "/")
    return bool(normalized) and not any(marker in normalized for marker in ("<", "...", "**"))


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
