"""ChangeSet 질문을 DDD 범위로 라우팅하는 경량 분석기."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


QUESTION_TERMS = (
    "?", "？", "왜", "무엇", "뭐", "어디", "어떻게", "어떤", "언제", "누가",
    "설명", "알려", "궁금", "질문", "동작", "흐름", "구조", "차이", "의미",
    "확인", "보여", "읽어", "조회", "why", "what", "where", "how", "explain",
    "describe", "show", "read",
)

IMPLEMENTATION_TERMS = (
    "구현해", "수정해", "고쳐", "추가해", "삭제해", "변경해", "만들어", "진행해",
    "실행해", "푸시", "커밋", "pr", "테스트해", "반영해", "적용해", "해결해",
    "implement", "fix", "change", "add", "remove", "delete", "run", "push",
    "commit", "apply",
)

EXPLICIT_IMPLEMENTATION_TERMS = (
    "구현 요청", "수정 요청", "변경 요청", "작업 요청", "구현 작업", "수정 작업",
    "implementation request", "change request", "implementation task",
)

SOURCE_ROOT_NAMES = ("src/main/java", "src/main/kotlin", "src/main/python", "src")
DOC_ROOTS = ("docs/use-cases", "docs/design", "docs/plans", "docs/changes")
MAX_DOC_BYTES = 180_000
MAX_SOURCE_CANDIDATES = 80


@dataclass(frozen=True)
class RouteCandidate:
    name: str
    kind: str
    confidence: float
    reasons: tuple[str, ...]
    paths: tuple[str, ...]


@dataclass(frozen=True)
class QuestionRoute:
    change_set_id: str
    query: str
    intent: str
    intent_reason: str
    work_item: str | None
    candidates: tuple[RouteCandidate, ...]
    preferred_read_scope: tuple[str, ...]
    read_order: tuple[str, ...]
    guardrails: tuple[str, ...]

    def to_json(self) -> str:
        return json.dumps(_to_plain(self), ensure_ascii=False, indent=2)

    def to_markdown(self) -> str:
        lines = [
            f"의도: {self.intent}",
            f"근거: {self.intent_reason}",
            f"ChangeSet: {self.change_set_id}",
        ]
        if self.work_item:
            lines.append(f"Work item: {self.work_item}")
        lines.append("")
        lines.append("후보 범위:")
        if self.candidates:
            for candidate in self.candidates:
                reason = "; ".join(candidate.reasons) or "-"
                paths = ", ".join(candidate.paths[:4]) or "-"
                lines.append(
                    f"- {candidate.kind}:{candidate.name} "
                    f"confidence={candidate.confidence:.2f} paths={paths} reason={reason}"
                )
        else:
            lines.append("- 후보 없음: ChangeSet 문서와 질문 토큰만으로 BC/module/aggregate를 특정하지 못함")
        lines.append("")
        lines.append("우선 조회 범위:")
        lines.extend(f"- {path}" for path in self.preferred_read_scope)
        lines.append("")
        lines.append("조회 순서:")
        lines.extend(f"- {item}" for item in self.read_order)
        lines.append("")
        lines.append("가드레일:")
        lines.extend(f"- {item}" for item in self.guardrails)
        return "\n".join(lines)


def route_changeset_question(
    repo_root: Path,
    change_set_id: str,
    query: str,
    *,
    work_item: str | None = None,
) -> QuestionRoute:
    normalized_query = query.strip()
    if not normalized_query:
        raise ValueError("질문이 비어 있습니다.")

    docs = _collect_document_evidence(repo_root, change_set_id, work_item)
    modules = _discover_modules(repo_root)
    candidates = _rank_candidates(repo_root, normalized_query, docs, modules)
    preferred_scope = _preferred_scope(change_set_id, work_item, candidates)
    return QuestionRoute(
        change_set_id=change_set_id,
        query=normalized_query,
        intent=_classify_intent(normalized_query),
        intent_reason=_intent_reason(normalized_query),
        work_item=work_item,
        candidates=tuple(candidates[:5]),
        preferred_read_scope=preferred_scope,
        read_order=_read_order(candidates[:5], work_item),
        guardrails=(
            "먼저 후보 BC/module/aggregate 경로와 해당 use-case 산출물만 읽는다.",
            "후보 밖 코드는 import, public API, 컴파일 오류, 호출 그래프 확인이 필요할 때만 확장한다.",
            "질문 의도가 구현 요청이면 답변 대신 구성된 orchestration agent 진입점으로 전달한다.",
        ),
    )


def _classify_intent(query: str) -> str:
    lowered = query.lower()
    if any(term in lowered for term in EXPLICIT_IMPLEMENTATION_TERMS):
        return "implementation"
    question_score = sum(1 for term in QUESTION_TERMS if term.lower() in lowered)
    implementation_score = sum(1 for term in IMPLEMENTATION_TERMS if term.lower() in lowered)
    if implementation_score > question_score:
        return "implementation"
    return "question"


def _intent_reason(query: str) -> str:
    lowered = query.lower()
    matched_questions = [term for term in QUESTION_TERMS if term.lower() in lowered][:5]
    matched_explicit_implementations = [
        term for term in EXPLICIT_IMPLEMENTATION_TERMS if term.lower() in lowered
    ][:5]
    matched_implementations = [term for term in IMPLEMENTATION_TERMS if term.lower() in lowered][:5]
    return (
        f"question_terms={matched_questions or '-'}; "
        f"explicit_implementation_terms={matched_explicit_implementations or '-'}; "
        f"implementation_terms={matched_implementations or '-'}"
    )


def _collect_document_evidence(
    repo_root: Path,
    change_set_id: str,
    work_item: str | None,
) -> dict[str, str]:
    paths: list[Path] = []
    for lifecycle in ("active", "completed"):
        paths.append(repo_root / "docs/changes" / lifecycle / f"{change_set_id}.md")
    if work_item:
        paths.extend((repo_root / root / work_item for root in DOC_ROOTS))
    else:
        paths.extend(repo_root.glob(f"docs/**/{change_set_id}*.md"))

    evidence = _read_evidence_paths(repo_root, paths)
    if not work_item:
        uc_ids = sorted(set(re.findall(r"\bUC-\d+\b", "\n".join(evidence.values()))))
        extra_paths = [
            repo_root / root / uc_id
            for uc_id in uc_ids
            for root in ("docs/use-cases", "docs/plans/active", "docs/plans/completed")
        ]
        evidence.update(_read_evidence_paths(repo_root, extra_paths, used_bytes=sum(map(len, evidence.values()))))
    return evidence


def _read_evidence_paths(
    repo_root: Path,
    paths: Iterable[Path],
    *,
    used_bytes: int = 0,
) -> dict[str, str]:
    evidence: dict[str, str] = {}
    total = 0
    for path in _existing_text_paths(paths):
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        remaining = MAX_DOC_BYTES - used_bytes - total
        if remaining <= 0:
            break
        clipped = content[:remaining]
        evidence[_repo_relative(repo_root, path)] = clipped
        total += len(clipped)
    return evidence


def _discover_modules(repo_root: Path) -> dict[str, tuple[str, ...]]:
    modules: dict[str, set[str]] = {}
    for settings_name in ("settings.gradle", "settings.gradle.kts"):
        settings = repo_root / settings_name
        if settings.exists():
            _read_gradle_modules(settings, modules)

    for root_name in SOURCE_ROOT_NAMES:
        for root in repo_root.glob(f"*/{root_name}"):
            if root.is_dir():
                relative_parts = root.relative_to(repo_root).parts
                module_name = relative_parts[0] if relative_parts else root.parent.name
                modules.setdefault(module_name, set()).add(module_name)
        root = repo_root / root_name
        if root.is_dir():
            modules.setdefault(repo_root.name, set()).add(".")
    for path in repo_root.glob("*/src"):
        if path.is_dir():
            modules.setdefault(path.parent.name, set()).add(_repo_relative(repo_root, path.parent))
    return {name: tuple(sorted(paths)) for name, paths in modules.items()}


def _read_gradle_modules(settings: Path, modules: dict[str, set[str]]) -> None:
    try:
        text = settings.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for match in re.finditer(r"include\s*\(?\s*([^)\\n]+)", text):
        segment = match.group(1)
        for quoted in re.findall(r"['\"](:?[^'\"]+)['\"]", segment):
            module_name = quoted.strip(":").split(":")[-1]
            if module_name:
                modules.setdefault(module_name, set()).add(module_name)


def _rank_candidates(
    repo_root: Path,
    query: str,
    docs: dict[str, str],
    modules: dict[str, tuple[str, ...]],
) -> list[RouteCandidate]:
    terms = _tokens(query)
    doc_text = "\n".join(docs.values()).lower()
    candidates: dict[tuple[str, str], RouteCandidate] = {}

    for module, paths in modules.items():
        score, reasons = _score_name(module, terms, doc_text)
        source_bonus = _source_path_bonus(repo_root, module, terms)
        if source_bonus:
            score += source_bonus
            reasons.append("source-path-match")
        if score > 0:
            candidates[("module", module)] = RouteCandidate(
                name=module,
                kind="module",
                confidence=min(0.99, score / 8),
                reasons=tuple(reasons),
                paths=paths,
            )

    for kind, section_name in (("bounded_context", "Bounded Contexts"), ("aggregate", "Aggregates")):
        for name in _extract_ddd_names(docs.values(), section_name):
            score, reasons = _score_name(name, terms, doc_text)
            if score > 0:
                candidates[(kind, name)] = RouteCandidate(
                    name=name,
                    kind=kind,
                    confidence=min(0.99, score / 7),
                    reasons=tuple(reasons),
                    paths=_paths_for_name(repo_root, name, modules),
                )

    return sorted(
        candidates.values(),
        key=lambda candidate: (candidate.confidence, len(candidate.paths)),
        reverse=True,
    )


def _score_name(name: str, terms: set[str], doc_text: str) -> tuple[int, list[str]]:
    normalized = _normalize_token(name)
    name_terms = _tokens(name)
    score = 0
    reasons: list[str] = []
    if normalized in terms or name_terms.intersection(terms):
        score += 5
        reasons.append("query-name-match")
    if normalized and normalized in doc_text:
        score += 2
        reasons.append("changeset-doc-match")
    for term in terms:
        if len(term) >= 4 and (term in normalized or normalized in term):
            score += 1
            reasons.append(f"partial:{term}")
            break
    return score, reasons


def _source_path_bonus(repo_root: Path, module: str, terms: set[str]) -> int:
    roots = [repo_root / module / "src", repo_root / module]
    checked = 0
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if checked >= MAX_SOURCE_CANDIDATES:
                return 0
            checked += 1
            if path.is_file() and _tokens(path.stem).intersection(terms):
                return 2
    return 0


def _extract_ddd_names(contents: Iterable[str], section_name: str) -> set[str]:
    names: set[str] = set()
    section_pattern = re.compile(
        rf"^##\s+{re.escape(section_name)}\s*$([\s\S]*?)(?=^##\s+|\Z)",
        re.MULTILINE,
    )
    for content in contents:
        for section in section_pattern.findall(content):
            for line in section.splitlines():
                if not line.startswith("|") or "---" in line:
                    continue
                cells = [cell.strip(" `") for cell in line.strip("|").split("|")]
                first_cell = cells[0] if cells else ""
                if first_cell and first_cell.lower() not in {"bounded context", "aggregate", "name"}:
                    names.add(first_cell)
    return names


def _paths_for_name(
    repo_root: Path,
    name: str,
    modules: dict[str, tuple[str, ...]],
) -> tuple[str, ...]:
    normalized = _normalize_token(name)
    matches: list[str] = []
    for module, paths in modules.items():
        if normalized in _normalize_token(module) or _normalize_token(module) in normalized:
            matches.extend(paths)
    if matches:
        return tuple(sorted(set(matches)))
    for path in repo_root.glob("*/src"):
        if normalized in _normalize_token(path.parent.name):
            matches.append(_repo_relative(repo_root, path.parent))
    return tuple(sorted(set(matches)))


def _preferred_scope(
    change_set_id: str,
    work_item: str | None,
    candidates: list[RouteCandidate],
) -> tuple[str, ...]:
    scope: list[str] = []
    if work_item:
        scope.extend(
            [
                f"docs/use-cases/{work_item}/",
                f"docs/plans/active/{work_item}/",
                f"docs/plans/completed/{work_item}/",
            ]
        )
    scope.append(f"docs/changes/active/{change_set_id}.md")
    scope.append(f"docs/changes/completed/{change_set_id}.md")
    for candidate in candidates[:3]:
        scope.extend(candidate.paths)
    return tuple(dict.fromkeys(scope))


def _read_order(candidates: list[RouteCandidate], work_item: str | None) -> tuple[str, ...]:
    items = [
        "ChangeSet 문서로 질문 대상과 완료된 work item 확인",
    ]
    if work_item:
        items.append(f"{work_item} use-case/DDD/technical-decision/plan 산출물 확인")
    items.extend(
        [
            "1순위 후보 module/BC의 domain/application 코드 확인",
            "같은 후보 범위의 adapter/infra/controller 코드는 호출 흐름이 필요할 때 확인",
            "후보 밖 shared/public API는 컴파일 참조 또는 import 확인 시에만 확인",
        ]
    )
    if candidates:
        items.append("최우선 후보: " + ", ".join(f"{c.kind}:{c.name}" for c in candidates[:3]))
    return tuple(items)


def _existing_text_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[Path] = set()
    result: list[Path] = []
    for path in paths:
        if path.is_dir():
            children = sorted(path.rglob("*.md"))
        else:
            children = [path]
        for child in children:
            if child.exists() and child.is_file() and child not in seen:
                seen.add(child)
                result.append(child)
    return result


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in re.split(r"[^0-9A-Za-z가-힣]+", value.lower())
        if len(token) >= 2
    }


def _normalize_token(value: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]+", "", value.lower())


def _repo_relative(repo_root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def _to_plain(value: Any) -> Any:
    if isinstance(value, QuestionRoute):
        return {
            "change_set_id": value.change_set_id,
            "query": value.query,
            "intent": value.intent,
            "intent_reason": value.intent_reason,
            "work_item": value.work_item,
            "candidates": [_to_plain(candidate) for candidate in value.candidates],
            "preferred_read_scope": list(value.preferred_read_scope),
            "read_order": list(value.read_order),
            "guardrails": list(value.guardrails),
        }
    if isinstance(value, RouteCandidate):
        return {
            "name": value.name,
            "kind": value.kind,
            "confidence": value.confidence,
            "reasons": list(value.reasons),
            "paths": list(value.paths),
        }
    return value
