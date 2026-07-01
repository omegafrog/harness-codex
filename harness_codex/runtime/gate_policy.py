"""Structured work-item gate selection and final changed-file reconciliation.

The initial gate plan is derived from the ChangeSet work-item type and its declared
impact tags. Scope and gate reduction come only from approved ChangeSet metadata.
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


class ImpactTag(str, Enum):
    """Canonical tags accepted in a ChangeSet work item's ``Impact Type`` column."""

    DOCUMENTATION = "documentation"
    SOURCE_CODE = "source-code"
    UI = "ui"
    SECURITY = "security"
    PUBLIC_API = "public-api"
    USER_FEATURE = "user-feature"
    UNKNOWN = "unknown"


_CANONICAL_TAGS = frozenset(tag.value for tag in ImpactTag if tag is not ImpactTag.UNKNOWN)
_TOKEN_SPLIT_RE = re.compile(r"[\s,;|/()\[\]{}:+]+")
_TOKEN_ALIASES: dict[str, ImpactTag] = {
    "documentation": ImpactTag.DOCUMENTATION,
    "document": ImpactTag.DOCUMENTATION,
    "docs": ImpactTag.DOCUMENTATION,
    "문서": ImpactTag.DOCUMENTATION,
    "source-code": ImpactTag.SOURCE_CODE,
    "source": ImpactTag.SOURCE_CODE,
    "code": ImpactTag.SOURCE_CODE,
    "backend": ImpactTag.SOURCE_CODE,
    "server": ImpactTag.SOURCE_CODE,
    "implementation": ImpactTag.SOURCE_CODE,
    "internal": ImpactTag.SOURCE_CODE,
    "cleanup": ImpactTag.SOURCE_CODE,
    "bug": ImpactTag.SOURCE_CODE,
    "코드": ImpactTag.SOURCE_CODE,
    "백엔드": ImpactTag.SOURCE_CODE,
    "서버": ImpactTag.SOURCE_CODE,
    "유지보수": ImpactTag.SOURCE_CODE,
    "버그": ImpactTag.SOURCE_CODE,
    "ui": ImpactTag.UI,
    "frontend": ImpactTag.UI,
    "browser": ImpactTag.UI,
    "screen": ImpactTag.UI,
    "화면": ImpactTag.UI,
    "프론트엔드": ImpactTag.UI,
    "보안": ImpactTag.SECURITY,
    "security": ImpactTag.SECURITY,
    "auth": ImpactTag.SECURITY,
    "authentication": ImpactTag.SECURITY,
    "authorization": ImpactTag.SECURITY,
    "permission": ImpactTag.SECURITY,
    "oauth": ImpactTag.SECURITY,
    "token": ImpactTag.SECURITY,
    "crypto": ImpactTag.SECURITY,
    "payment": ImpactTag.SECURITY,
    "privacy": ImpactTag.SECURITY,
    "인증": ImpactTag.SECURITY,
    "인가": ImpactTag.SECURITY,
    "권한": ImpactTag.SECURITY,
    "토큰": ImpactTag.SECURITY,
    "결제": ImpactTag.SECURITY,
    "암호화": ImpactTag.SECURITY,
    "public-api": ImpactTag.PUBLIC_API,
    "api": ImpactTag.PUBLIC_API,
    "public": ImpactTag.PUBLIC_API,
    "external": ImpactTag.PUBLIC_API,
    "외부": ImpactTag.PUBLIC_API,
    "공개": ImpactTag.PUBLIC_API,
    "user-feature": ImpactTag.USER_FEATURE,
    "feature": ImpactTag.USER_FEATURE,
    "user": ImpactTag.USER_FEATURE,
    "사용자": ImpactTag.USER_FEATURE,
    "기능": ImpactTag.USER_FEATURE,
}


@dataclass(frozen=True)
class GateDecision:
    """One applied or skipped gate with its audit reason."""

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
    impact_tags: tuple[ImpactTag, ...]
    risk_level: str
    decisions: tuple[GateDecision, ...]

    @property
    def impact_contract_valid(self) -> bool:
        return ImpactTag.UNKNOWN not in self.impact_tags

    def decision_for(self, gate_id: str) -> GateDecision:
        for decision in self.decisions:
            if decision.gate_id == gate_id:
                return decision
        return GateDecision(
            gate_id=gate_id,
            requirement=GateRequirement.REQUIRED,
            reason="The workflow does not declare this required gate explicitly.",
            waiver_allowed=False,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "work_item_id": self.work_item_id,
            "work_item_type": self.work_item_type.value,
            "impact_type": self.impact_type,
            "impact_tags": [tag.value for tag in self.impact_tags],
            "impact_contract_valid": self.impact_contract_valid,
            "risk_level": self.risk_level,
            "gates": [decision.as_dict() for decision in self.decisions],
        }


@dataclass(frozen=True)
class GateEscalation:
    """A delivery-time condition that requires ChangeSet revision and re-verification."""

    gate_id: str
    reason: str
    observed_paths: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "gate_id": self.gate_id,
            "reason": self.reason,
            "observed_paths": list(self.observed_paths),
        }


def parse_impact_tags(impact_type: str) -> tuple[ImpactTag, ...]:
    """Parse canonical ChangeSet impact tags with narrow legacy aliases.

    New ChangeSets should use a comma-separated subset of
    ``documentation, source-code, ui, security, public-api, user-feature``.
    Legacy Korean/English labels are accepted only through exact token aliases.
    Unknown values are retained as ``unknown`` and block delivery instead of
    silently weakening verification.
    """

    raw = impact_type.casefold().strip()
    if not raw:
        return (ImpactTag.UNKNOWN,)
    tokens = tuple(token for token in _TOKEN_SPLIT_RE.split(raw) if token)
    tags = {tag for token in tokens if (tag := _TOKEN_ALIASES.get(token)) is not None}
    for canonical in _CANONICAL_TAGS:
        if canonical in tokens:
            tags.add(ImpactTag(canonical))
    if not tags:
        return (ImpactTag.UNKNOWN,)
    return tuple(sorted(tags, key=lambda tag: tag.value))


def derive_gate_policy(
    *,
    work_item_id: str,
    work_item_type: WorkItemType,
    impact_type: str = "",
    affected_paths: Iterable[str | Path] = (),
) -> GatePolicy:
    """Derive an enforceable policy from approved ChangeSet metadata.

    ``affected_paths`` is deliberately ignored. It is maintained while planning and
    must never lower checks chosen from the approved work-item impact.
    """

    del affected_paths
    tags = parse_impact_tags(impact_type)
    tag_set = set(tags)
    docs_only = tag_set == {ImpactTag.DOCUMENTATION}
    ui = ImpactTag.UI in tag_set
    security = ImpactTag.SECURITY in tag_set
    user_visible = (
        ImpactTag.PUBLIC_API in tag_set
        or ImpactTag.USER_FEATURE in tag_set
        or work_item_type in {WorkItemType.USE_CASE, WorkItemType.FEATURE_EXTENSION}
    )
    unknown = ImpactTag.UNKNOWN in tag_set

    risk_level = (
        "unknown"
        if unknown
        else "security-sensitive"
        if security
        else "ui"
        if ui
        else "feature"
        if user_visible
        else "documentation"
        if docs_only
        else "source-code"
    )

    decisions: list[GateDecision] = [
        _required("scope-contract", "ChangeSet scope and selected work item must match."),
        _required("placeholder-resolution", "Planning scope declarations must not contain placeholders."),
        _required("verification-evidence", "Completion requires retained verification evidence."),
        _required("out-of-scope-detection", "Changes outside the declared work-item scope must be blocked."),
        _required("plan-review", "The implementation plan requires an approved review record."),
        _required("verification", "Every work item requires executable or documented verification evidence."),
    ]

    if unknown:
        decisions.append(_required("impact-contract", "Impact Type must use declared canonical impact tags."))
    else:
        decisions.append(_skipped("impact-contract", "The ChangeSet impact tags are valid."))

    if security:
        decisions.extend(
            (
                _required("security-review", "Security impact requires independent security review."),
                _required("static-analysis", "Security impact requires static-analysis command evidence."),
            )
        )
    else:
        decisions.extend(
            (
                _skipped("security-review", "No security impact is declared."),
                _skipped("static-analysis", "No security impact is declared."),
            )
        )

    if ui:
        decisions.extend(
            (
                _required("browser-ui", "UI impact requires browser-visible command evidence."),
                _required("runtime-server", "UI impact requires runnable runtime command evidence."),
            )
        )
    else:
        decisions.extend(
            (
                _skipped("browser-ui", "No UI impact is declared."),
                _skipped("runtime-server", "No UI impact is declared."),
            )
        )

    if docs_only:
        decisions.extend(
            (
                _skipped("full-e2e", "Documentation-only work has no product E2E behavior."),
                _skipped("test-gate", "Documentation-only work uses documented verification evidence."),
            )
        )
    elif user_visible:
        decisions.extend(
            (
                _required("full-e2e", "User-visible behavior requires E2E command evidence."),
                _required("test-gate", "Source behavior requires the repository test gate."),
            )
        )
    else:
        decisions.extend(
            (
                _skipped("full-e2e", "No user-visible behavior is declared."),
                _required("test-gate", "Source-code work requires the repository test gate."),
            )
        )

    return GatePolicy(
        work_item_id=work_item_id,
        work_item_type=work_item_type,
        impact_type=impact_type,
        impact_tags=tags,
        risk_level=risk_level,
        decisions=tuple(decisions),
    )


def derive_gate_policy_for_scope(
    repo_root: Path | str,
    scope: PlanningInputScope,
    *,
    impact_type: str | None = None,
) -> GatePolicy:
    """Derive policy from resolved ChangeSet scope metadata, never planned file paths."""

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
    """Return delivery blockers for invalid impact contracts or under-classified diffs."""

    policy_list = tuple(policies)
    if not policy_list:
        return ()

    escalations: list[GateEscalation] = [
        GateEscalation(
            "impact-contract",
            "ChangeSet Impact Type must use canonical impact tags before delivery.",
            (),
        )
        for policy in policy_list
        if not policy.impact_contract_valid
    ]
    paths = tuple(dict.fromkeys(_normalize_path(path) for path in changed_paths if str(path).strip()))
    if not paths:
        return tuple(_dedupe_escalations(escalations))

    source_paths = tuple(path for path in paths if not _is_document_path(path))
    observations: list[tuple[str, str, tuple[str, ...]]] = []
    ui_paths = tuple(path for path in source_paths if _is_ui_path(path))
    if ui_paths:
        observations.extend(
            (
                ("browser-ui", "Actual source changes include UI paths, but browser verification was skipped.", ui_paths),
                ("runtime-server", "Actual source changes include UI paths, but runtime verification was skipped.", ui_paths),
            )
        )
    security_paths = tuple(path for path in source_paths if _is_security_path(path))
    if security_paths:
        observations.extend(
            (
                ("security-review", "Actual source changes include security-sensitive paths, but security review was skipped.", security_paths),
                ("static-analysis", "Actual source changes include security-sensitive paths, but static analysis was skipped.", security_paths),
            )
        )
    if source_paths:
        observations.append(
            ("test-gate", "Actual source changes exist, but the repository test gate was skipped.", source_paths)
        )

    for gate_id, reason, observed_paths in observations:
        if _combined_requirement(policy_list, gate_id) is GateRequirement.SKIPPED:
            escalations.append(GateEscalation(gate_id, reason, observed_paths))
    return tuple(_dedupe_escalations(escalations))


def _dedupe_escalations(escalations: Iterable[GateEscalation]) -> tuple[GateEscalation, ...]:
    deduped: dict[str, GateEscalation] = {}
    for escalation in escalations:
        deduped.setdefault(escalation.gate_id, escalation)
    return tuple(deduped.values())


def _combined_requirement(policies: tuple[GatePolicy, ...], gate_id: str) -> GateRequirement:
    requirements = {policy.decision_for(gate_id).requirement for policy in policies}
    if GateRequirement.REQUIRED in requirements:
        return GateRequirement.REQUIRED
    if GateRequirement.CONDITIONAL in requirements:
        return GateRequirement.CONDITIONAL
    if GateRequirement.OPTIONAL in requirements:
        return GateRequirement.OPTIONAL
    return GateRequirement.SKIPPED


def _normalize_path(value: str | Path) -> str:
    return str(value).strip().lower().replace("\\", "/")


def _is_document_path(path: str) -> bool:
    return path.startswith("docs/") or path in {"readme.md", "changelog.md"} or path.endswith(".md")


def _path_tokens(path: str) -> frozenset[str]:
    return frozenset(token for token in re.split(r"[^a-z0-9가-힣]+", path) if token)


def _is_ui_path(path: str) -> bool:
    if path.endswith((".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss")):
        return True
    return bool(_path_tokens(path) & {"frontend", "ui", "web", "templates", "static", "screen", "screens"})


def _is_security_path(path: str) -> bool:
    return bool(
        _path_tokens(path)
        & {
            "auth",
            "authentication",
            "authorization",
            "security",
            "permission",
            "permissions",
            "oauth",
            "token",
            "tokens",
            "crypto",
            "secret",
            "secrets",
            "payment",
            "payments",
            "billing",
            "identity",
            "session",
            "rbac",
            "인증",
            "인가",
            "권한",
            "토큰",
            "보안",
            "결제",
        }
    )


def _required(gate_id: str, reason: str) -> GateDecision:
    return GateDecision(gate_id, GateRequirement.REQUIRED, reason, waiver_allowed=False)


def _skipped(gate_id: str, reason: str) -> GateDecision:
    return GateDecision(gate_id, GateRequirement.SKIPPED, reason, waiver_allowed=False)
