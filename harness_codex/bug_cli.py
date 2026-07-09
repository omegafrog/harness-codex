"""버그 수정 전용 경량 workflow CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from xml.etree import ElementTree

from harness_codex.runtime.changeset_memory import ChangeSetMemoryError, search_memory
from harness_codex.runtime.file_memory_cache import FileMemoryCacheError, warm_file_cache
from harness_codex.runtime.graph_context import (
    GraphContextError,
    graph_context_status,
    query_graph_context,
)
from harness_codex.runtime.worktree_support import (
    add_worktree,
    git,
    hydrate_runtime_worktree,
    is_git_worktree,
    remove_worktree,
    safe_ref_part,
    usable_worktree,
    worktrees_base_dir,
)

BUG_ID_PATTERN = re.compile(r"^BUG-\d{8}-\d{3}$")
BUG_TIERS = ("hotfix", "behavior", "architecture", "incident")
BUG_SEVERITIES = ("low", "medium", "high", "critical")


@dataclass(frozen=True)
class BugContext:
    bug_id: str
    title: str
    severity: str
    tier: str
    symptom: str
    paths: tuple[str, ...]
    memory_context: str
    graph_context: str


@dataclass(frozen=True)
class BugRunWorktree:
    root: Path
    branch: str


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.repo_root)
    try:
        output = args.func(args, root)
    except (
        BugWorkflowError,
        ChangeSetMemoryError,
        FileMemoryCacheError,
        GraphContextError,
        ValueError,
    ) as error:
        print(str(error), file=sys.stderr)
        return 2
    if output:
        print(output)
    return 0


class BugWorkflowError(ValueError):
    pass


def start_bug_workflow(
    root: Path,
    *,
    title: str,
    symptom: str,
    severity: str = "medium",
    tier: str | None = None,
    paths: tuple[str, ...] = (),
) -> dict[str, str]:
    bug_id = _next_bug_id(root)
    resolved_tier = tier or _infer_tier(severity, symptom)
    bug_dir = root / "docs" / "maintenance" / bug_id
    if bug_dir.exists():
        raise BugWorkflowError(f"bug slice already exists: {bug_dir.relative_to(root)}")
    context = _bug_context(
        root,
        bug_id=bug_id,
        title=title,
        severity=severity,
        tier=resolved_tier,
        symptom=symptom,
        paths=paths,
    )
    bug_dir.mkdir(parents=True)
    files = {
        "index.xml": _render_index_xml(context, "draft"),
        "change-intent.md": _render_change_intent(context),
        "verification-goal.md": _render_verification_goal(context),
        "triage.md": _render_triage(context),
    }
    if resolved_tier in {"architecture", "incident"}:
        files["technical-decisions.md"] = _render_technical_decisions(context)
    for name, body in files.items():
        (bug_dir / name).write_text(body, encoding="utf-8")
    warm_file_cache(root, [f"docs/maintenance/{bug_id}/{name}" for name in files])
    return {
        "bug_id": bug_id,
        "tier": resolved_tier,
        "severity": severity,
        "path": f"docs/maintenance/{bug_id}",
        "next": f"harness bug plan {bug_id}",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness bug",
        description="memory, cache, graph context를 사용하는 경량 버그 수정 workflow.",
    )
    parser.add_argument("--repo-root", default=".")
    commands = parser.add_subparsers(dest="bug_command", required=True)

    start = commands.add_parser("start", help="버그 maintenance slice를 생성한다.")
    start.add_argument("--title", required=True)
    start.add_argument("--symptom", required=True)
    start.add_argument("--severity", choices=BUG_SEVERITIES, default="medium")
    start.add_argument("--tier", choices=BUG_TIERS)
    start.add_argument("--path", action="append", default=[])
    start.set_defaults(func=start_command_handler)

    triage = commands.add_parser("triage", help="memory/cache/graph triage context를 갱신한다.")
    triage.add_argument("bug_id")
    triage.add_argument("--query")
    triage.set_defaults(func=triage_command_handler)

    plan = commands.add_parser("plan", help="집중된 버그 수정 계획을 생성한다.")
    plan.add_argument("bug_id")
    plan.set_defaults(func=plan_command_handler)

    run = commands.add_parser("run", help="구현/검증 loop를 제한 횟수 안에서 자동 반복한다.")
    run.add_argument("bug_id")
    run.add_argument("--implement-command", required=True)
    run.add_argument("--verify-command", action="append", default=[])
    run.add_argument("--max-loops", type=int, default=2)
    run.set_defaults(func=run_command_handler)

    verify = commands.add_parser("verify", help="집중 검증 명령을 표시한다.")
    verify.add_argument("bug_id")
    verify.set_defaults(func=verify_command_handler)

    complete = commands.add_parser("complete", help="버그 slice를 완료 처리한다.")
    complete.add_argument("bug_id")
    complete.set_defaults(func=complete_command_handler)
    return parser


def start_command_handler(args: argparse.Namespace, root: Path) -> str:
    started = start_bug_workflow(
        root,
        title=args.title,
        symptom=args.symptom,
        severity=args.severity,
        tier=args.tier,
        paths=tuple(args.path),
    )
    return "\n".join(
        [
            f"bug_id={started['bug_id']}",
            f"tier={started['tier']}",
            f"severity={started['severity']}",
            f"path={started['path']}",
            f"next={started['next']}",
        ]
    )


def triage_command_handler(args: argparse.Namespace, root: Path) -> str:
    bug_dir = _bug_dir(root, args.bug_id)
    fields = _read_bug_fields(bug_dir)
    query = args.query or " ".join(
        part
        for part in (
            fields.get("title", ""),
            fields.get("tier", ""),
            fields.get("symptom", ""),
        )
        if part
    )
    context = _bug_context(
        root,
        bug_id=args.bug_id,
        title=fields.get("title", args.bug_id),
        severity=fields.get("severity", "medium"),
        tier=fields.get("tier", "behavior"),
        symptom=fields.get("symptom", ""),
        paths=tuple(_field_list(fields.get("paths", ""))),
        query=query,
    )
    triage_path = bug_dir / "triage.md"
    triage_path.write_text(_render_triage(context), encoding="utf-8")
    warm_file_cache(root, [triage_path.relative_to(root)])
    return "\n".join(
        [
            f"bug_id={args.bug_id}",
            f"triage=docs/maintenance/{args.bug_id}/triage.md",
            f"graph={_first_line(context.graph_context)}",
            "next=harness bug plan " + args.bug_id,
        ]
    )


def plan_command_handler(args: argparse.Namespace, root: Path) -> str:
    bug_dir = _bug_dir(root, args.bug_id)
    fields = _read_bug_fields(bug_dir)
    plan_dir = root / "docs" / "plans" / "active" / args.bug_id
    plan_dir.mkdir(parents=True, exist_ok=True)
    plan_path = plan_dir / "plan.md"
    plan_path.write_text(_render_plan(args.bug_id, fields), encoding="utf-8")
    warm_file_cache(root, [plan_path.relative_to(root), bug_dir.relative_to(root) / "triage.md"])
    return "\n".join(
        [
            f"bug_id={args.bug_id}",
            f"plan=docs/plans/active/{args.bug_id}/plan.md",
            "next=구현 후 harness bug verify " + args.bug_id,
        ]
    )


def verify_command_handler(args: argparse.Namespace, root: Path) -> str:
    bug_dir = _bug_dir(root, args.bug_id)
    fields = _read_bug_fields(bug_dir)
    goal_path = bug_dir / "verification-goal.md"
    warm_file_cache(root, [goal_path.relative_to(root)])
    return "\n".join(
        [
            f"bug_id={args.bug_id}",
            "required=실패 재현 테스트 또는 재현 증거",
            "targeted=영향 파일/모듈 테스트",
            "full=./venv/bin/python3 -m pytest -q -s",
            f"tier={fields.get('tier', 'behavior')}",
            "next=검증 통과 후 harness bug complete " + args.bug_id,
        ]
    )


def run_command_handler(args: argparse.Namespace, root: Path) -> str:
    if args.max_loops < 1:
        raise BugWorkflowError("--max-loops must be >= 1")
    if not is_git_worktree(root):
        raise BugWorkflowError("bug run requires a git repository for worktree isolation")
    head = git(root, "rev-parse", "--verify", "HEAD", check=False)
    if head.returncode != 0:
        raise BugWorkflowError("bug run requires at least one commit before creating an isolated worktree")
    bug_dir = _bug_dir(root, args.bug_id)
    plan_path = root / "docs" / "plans" / "active" / args.bug_id / "plan.md"
    if not plan_path.is_file():
        raise BugWorkflowError(f"missing bug plan: {plan_path.relative_to(root)}")
    state_path = bug_dir / "loop-state.json"
    bug_worktree = _prepare_bug_run_worktree(root, args.bug_id)
    _update_bug_status(bug_dir, "running")
    previous_fingerprints: list[str] = []
    loop_reports: list[dict[str, object]] = []

    for loop_index in range(1, args.max_loops + 1):
        before = _git_changed_files(bug_worktree.root)
        implement = _run_shell(args.implement_command, bug_worktree.root)
        after_implement = _git_changed_files(bug_worktree.root)
        changed_files = sorted(after_implement - before)
        verify_results = tuple(_run_shell(command, bug_worktree.root) for command in args.verify_command)
        fingerprint = _loop_failure_fingerprint(
            implement=implement,
            verify_results=verify_results,
            changed_files=changed_files,
        )
        report = {
            "loop": loop_index,
            "implement_command": args.implement_command,
            "implement_exit_code": implement.returncode,
            "verify_results": [
                {
                    "command": result.command,
                    "exit_code": result.returncode,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                }
                for result in verify_results
            ],
            "changed_files": changed_files,
            "failure_fingerprint": fingerprint,
            "worktree_root": str(bug_worktree.root),
            "worktree_branch": bug_worktree.branch,
        }
        loop_reports.append(report)
        _write_loop_state(
            state_path,
            args.bug_id,
            "running",
            loop_reports,
            worktree_root=bug_worktree.root,
            worktree_branch=bug_worktree.branch,
        )
        failure_reason = _loop_failure_reason(
            implement=implement,
            verify_results=verify_results,
            changed_files=changed_files,
        )
        if failure_reason is None:
            _update_bug_status(bug_dir, "completed")
            _write_loop_state(
                state_path,
                args.bug_id,
                "completed",
                loop_reports,
                worktree_root=bug_worktree.root,
                worktree_branch=bug_worktree.branch,
            )
            return "\n".join(
                [
                    f"bug_id={args.bug_id}",
                    "status=completed",
                    f"loops={loop_index}",
                    f"worktree={bug_worktree.root}",
                    "next=harness bug complete " + args.bug_id,
                ]
            )
        if fingerprint in previous_fingerprints:
            _update_bug_status(bug_dir, "blocked")
            _write_loop_state(
                state_path,
                args.bug_id,
                "blocked",
                loop_reports,
                blocker=failure_reason,
                worktree_root=bug_worktree.root,
                worktree_branch=bug_worktree.branch,
            )
            raise BugWorkflowError(
                f"bug loop blocked after repeated failure fingerprint: {failure_reason}"
            )
        previous_fingerprints.append(fingerprint)

    blocker = _loop_failure_reason_from_report(loop_reports[-1]) or "unknown bug loop failure"
    _update_bug_status(bug_dir, "blocked")
    _write_loop_state(
        state_path,
        args.bug_id,
        "blocked",
        loop_reports,
        blocker=blocker,
        worktree_root=bug_worktree.root,
        worktree_branch=bug_worktree.branch,
    )
    raise BugWorkflowError(f"bug loop blocked after {args.max_loops} attempts: {blocker}")


def complete_command_handler(args: argparse.Namespace, root: Path) -> str:
    bug_dir = _bug_dir(root, args.bug_id)
    _update_bug_status(bug_dir, "completed")
    return "\n".join(
        [
            f"bug_id={args.bug_id}",
            "status=completed",
            "memory=반복 가능 버그면 docs/memory/failure-patterns 후보로 승격 검토",
            "graph=소스/산출물 변경 후 harness memory graph status 확인",
        ]
    )


def _bug_context(
    root: Path,
    *,
    bug_id: str,
    title: str,
    severity: str,
    tier: str,
    symptom: str,
    paths: tuple[str, ...],
    query: str | None = None,
) -> BugContext:
    context_query = query or " ".join(part for part in (title, severity, tier, symptom, *paths) if part)
    memory_context = _memory_context(root, context_query)
    graph_context = _graph_context(root, context_query)
    return BugContext(
        bug_id=bug_id,
        title=title,
        severity=severity,
        tier=tier,
        symptom=symptom,
        paths=paths,
        memory_context=memory_context,
        graph_context=graph_context,
    )


def _memory_context(root: Path, query: str) -> str:
    hits = search_memory(root, query, kind="failure_pattern", limit=3)
    if not hits:
        hits = search_memory(root, query, limit=3)
    if not hits:
        return "검색 결과 없음"
    lines = []
    for hit in hits:
        lines.append(
            f"- `{hit.document.memory_id}` score={hit.score:.3f} source=`{hit.document.source_path}`"
        )
    return "\n".join(lines)


def _graph_context(root: Path, query: str) -> str:
    status = graph_context_status(root)
    lines = [
        f"status exists={str(status.exists).lower()} stale={str(status.stale).lower()} nodes={status.nodes} edges={status.edges} communities={status.communities}",
    ]
    if status.stale:
        lines.append("권장: `harness memory graph rebuild`")
    if not status.exists or status.stale:
        return "\n".join(lines)
    try:
        result = query_graph_context(root, query, budget=700)
    except GraphContextError as error:
        lines.append(f"query_error={error}")
        return "\n".join(lines)
    lines.append(result or "query_result=empty")
    return "\n".join(lines)


def _render_index_xml(context: BugContext, status: str) -> str:
    documents = [
        ("change-intent.md", "버그 증상과 수정 범위", "draft"),
        ("triage.md", "memory/cache/graph 기반 탐색 결과", "draft"),
        ("verification-goal.md", "재현/검증 기준", "draft"),
        ("technical-decisions.md", "경계/정책 결정", _technical_decision_status(context.tier)),
    ]
    lines = [
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
        "<bug-slice>",
        f"  <bug-id>{_xml_escape(context.bug_id)}</bug-id>",
        f"  <title>{_xml_escape(context.title)}</title>",
        f"  <status>{_xml_escape(status)}</status>",
        f"  <severity>{_xml_escape(context.severity)}</severity>",
        f"  <workflow-tier>{_xml_escape(context.tier)}</workflow-tier>",
        f"  <updated-at>{date.today().isoformat()}</updated-at>",
        "  <documents>",
    ]
    for name, purpose, doc_status in documents:
        lines.extend(
            [
                f"    <document path=\"{_xml_escape(name)}\" status=\"{_xml_escape(doc_status)}\">",
                f"      <purpose>{_xml_escape(purpose)}</purpose>",
                "    </document>",
            ]
        )
    lines.extend(
        [
            "  </documents>",
            "  <checks>",
            "    <check>재현 테스트 또는 재현 증거 확보</check>",
            "  </checks>",
            "</bug-slice>",
        ]
    )
    return "\n".join(lines) + "\n"


def _render_change_intent(context: BugContext) -> str:
    paths = "\n".join(f"- `{path}`" for path in context.paths) or "- 미지정"
    return f"""# {context.bug_id}. {context.title} Change Intent

## 1. 개요

- 작업 유형: bugfix
- Workflow tier: {context.tier}
- 심각도: {context.severity}
- 목표: 관찰된 버그를 재현 가능한 증거로 고정하고 최소 범위에서 수정한다.

## 2. 증상

{context.symptom}

## 3. 영향 후보 경로

{paths}

## 4. Scope Boundary

### 포함

- 버그 재현 테스트 또는 재현 증거
- 원인 파일의 최소 수정
- 영향 범위 검증

### 제외

- 승인되지 않은 기능 확장
- 관련 없는 리팩터링
- canonical design 문서 임의 변경

## 5. 완료 조건

- `verification-goal.md` 성공 기준 충족
- targeted verification 통과
- 필요한 경우 full test gate 통과
"""


def _render_verification_goal(context: BugContext) -> str:
    return f"""# {context.bug_id}. {context.title} Verification Goal

## 1. 메타데이터

|항목|값|
|---|---|
|Bug ID|`{context.bug_id}`|
|심각도|{context.severity}|
|Workflow tier|{context.tier}|
|승인 상태|pending|

## 2. Given / When / Then

### Given

- 버그 증상: {context.symptom}

### When

- 사용자가 버그를 유발한 동작을 다시 수행한다.

### Then

- 기존 실패 증상이 재발하지 않는다.
- 회귀 테스트 또는 재현 증거가 통과한다.

## 3. 검증 방법

|단계|명령|성공 기준|필수 여부|
|---|---|---|---|
|Reproduction|실패 테스트 또는 재현 스크립트|수정 전 실패, 수정 후 성공|required|
|Targeted Test|영향 모듈 테스트|exit code 0|required|
|Full Test|`./venv/bin/python3 -m pytest -q -s`|exit code 0|required when applicable|
"""


def _render_triage(context: BugContext) -> str:
    return f"""# {context.bug_id}. {context.title} Triage

## 1. Workflow tier

{context.tier}

## 2. Memory 검색

{context.memory_context}

## 3. Graph 검색

{context.graph_context}

## 4. Cache 사용

- 생성 문서는 `harness memory cache`로 warm 처리한다.
- 수정 전후 원본 파일은 직접 확인한다.
"""


def _render_technical_decisions(context: BugContext) -> str:
    return f"""# {context.bug_id}. {context.title} Technical Decisions

## 1. 결정 필요성

- Workflow tier: {context.tier}
- 경계, 트랜잭션, 동시성, idempotency, rollback 정책 영향 가능성이 있다.

## 2. 결정 표

|영역|결정|이유|구현 반영|검증 반영|상태|
|---|---|---|---|---|---|
|Transaction boundary| | | | |pending|
|Idempotency / retry| | | | |pending|
|Data compatibility| | | | |pending|
|Rollback| | | | |pending|

## 3. 미해결 결정

- 없음
"""


def _render_plan(bug_id: str, fields: dict[str, str]) -> str:
    tier = fields.get("tier", "behavior")
    technical_step = (
        "- [ ] `technical-decisions.md`의 pending 결정 해결\n"
        if tier in {"architecture", "incident"}
        else ""
    )
    return f"""# {bug_id}. 버그 수정 계획

## 1. 범위

- 제목: {fields.get("title", bug_id)}
- Workflow tier: {tier}
- 심각도: {fields.get("severity", "medium")}

## 2. 체크리스트

- [ ] `change-intent.md` 범위 확인
- [ ] `triage.md`의 memory/cache/graph 결과 확인
{technical_step}- [ ] 실패 테스트 또는 재현 증거 작성
- [ ] 최소 수정 구현
- [ ] targeted verification 실행
- [ ] 필요한 경우 full test 실행
- [ ] 반복 실패 fingerprint 확인
- [ ] `harness memory graph status` 확인

## 3. 차단 조건

- 기대 동작이 불명확하면 구현 중단
- 도메인 정책 변경이 필요하면 use-case 또는 technical decision으로 승격
- 보안/금전 영향이 확인되면 incident tier로 승격
"""


def _next_bug_id(root: Path) -> str:
    today = date.today().strftime("%Y%m%d")
    maintenance_root = root / "docs" / "maintenance"
    existing = []
    if maintenance_root.exists():
        for path in maintenance_root.iterdir():
            if path.is_dir() and path.name.startswith(f"BUG-{today}-"):
                existing.append(path.name)
    sequence = 1
    if existing:
        sequence = max(int(name.rsplit("-", 1)[1]) for name in existing) + 1
    return f"BUG-{today}-{sequence:03d}"


def _infer_tier(severity: str, symptom: str) -> str:
    lowered = symptom.lower()
    if severity == "critical" or any(token in lowered for token in ("incident", "outage", "data loss", "security", "payment")):
        return "incident"
    if any(token in lowered for token in ("transaction", "idempot", "race", "concurrency", "outbox", "boundary")):
        return "architecture"
    if severity == "low":
        return "hotfix"
    return "behavior"


def _bug_dir(root: Path, bug_id: str) -> Path:
    if not BUG_ID_PATTERN.match(bug_id):
        raise BugWorkflowError(f"invalid bug id: {bug_id}")
    path = root / "docs" / "maintenance" / bug_id
    if not path.is_dir():
        raise BugWorkflowError(f"unknown bug slice: docs/maintenance/{bug_id}")
    return path


def _read_bug_fields(bug_dir: Path) -> dict[str, str]:
    index = _read_index_xml(bug_dir / "index.xml")
    change = (bug_dir / "change-intent.md").read_text(encoding="utf-8") if (bug_dir / "change-intent.md").exists() else ""
    fields = {
        "title": index.get("title", bug_dir.name) or bug_dir.name,
        "severity": index.get("severity", "medium") or "medium",
        "tier": index.get("workflow-tier", "behavior") or "behavior",
        "symptom": _section_body(change, "## 2. 증상"),
        "paths": _section_body(change, "## 3. 영향 후보 경로"),
    }
    return fields


def _read_index_xml(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    root = ElementTree.fromstring(path.read_text(encoding="utf-8"))
    fields: dict[str, str] = {}
    for tag in ("bug-id", "title", "status", "severity", "workflow-tier", "updated-at"):
        value = root.findtext(tag)
        if value is not None:
            fields[tag] = value.strip()
    return fields


def _section_body(text: str, heading: str) -> str:
    if heading not in text:
        return ""
    tail = text.split(heading, 1)[1].strip()
    parts = re.split(r"\n## ", tail, maxsplit=1)
    return parts[0].strip()


def _field_list(value: str) -> list[str]:
    paths = []
    for line in value.splitlines():
        line = line.strip()
        if line.startswith("- `") and line.endswith("`"):
            paths.append(line[3:-1])
    return paths


def _technical_decision_status(tier: str) -> str:
    return "draft" if tier in {"architecture", "incident"} else "not required"


def _first_line(value: str) -> str:
    return next((line for line in value.splitlines() if line.strip()), "")


def _prepare_bug_run_worktree(repo_root: Path, bug_id: str) -> BugRunWorktree:
    safe_bug = safe_ref_part(bug_id)
    safe_run = safe_ref_part("bug-run")
    worktree_root = worktrees_base_dir(repo_root, safe_bug, safe_run) / "execution"
    branch = f"harness/bug/{safe_bug}/execution"
    reuse = usable_worktree(worktree_root, branch)
    if worktree_root.exists() and not reuse:
        remove_worktree(repo_root, worktree_root)
    if not reuse:
        add_worktree(repo_root, worktree_root, branch, "HEAD")
    hydrate_runtime_worktree(repo_root, worktree_root, copy_project_docs=True)
    return BugRunWorktree(root=worktree_root, branch=branch)


@dataclass(frozen=True)
class ShellResult:
    command: str
    returncode: int
    stdout: str
    stderr: str


def _run_shell(command: str, root: Path) -> ShellResult:
    completed = subprocess.run(
        command,
        cwd=root,
        shell=True,
        text=True,
        capture_output=True,
        check=False,
    )
    return ShellResult(
        command=command,
        returncode=completed.returncode,
        stdout=completed.stdout.strip(),
        stderr=completed.stderr.strip(),
    )


def _git_changed_files(root: Path) -> set[str]:
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return set()
    return {
        line[3:].strip()
        for line in completed.stdout.splitlines()
        if len(line) >= 4 and line[3:].strip()
    }


def _loop_failure_reason(
    *,
    implement: ShellResult,
    verify_results: tuple[ShellResult, ...],
    changed_files: list[str],
) -> str | None:
    if implement.returncode != 0:
        return f"implement command failed: {implement.command}"
    failed_verify = next((item for item in verify_results if item.returncode != 0), None)
    if failed_verify is not None:
        return f"verify command failed: {failed_verify.command}"
    if not changed_files:
        return "implement command made no tracked worktree changes"
    return None


def _loop_failure_reason_from_report(report: dict[str, object]) -> str | None:
    if int(report.get("implement_exit_code", 0)) != 0:
        return f"implement command failed: {report.get('implement_command', '')}"
    for item in report.get("verify_results", []):
        if isinstance(item, dict) and int(item.get("exit_code", 0)) != 0:
            return f"verify command failed: {item.get('command', '')}"
    changed_files = report.get("changed_files", [])
    if isinstance(changed_files, list) and not changed_files:
        return "implement command made no tracked worktree changes"
    return None


def _loop_failure_fingerprint(
    *,
    implement: ShellResult,
    verify_results: tuple[ShellResult, ...],
    changed_files: list[str],
) -> str:
    payload = {
        "implement_command": implement.command,
        "implement_exit_code": implement.returncode,
        "implement_stdout": implement.stdout,
        "implement_stderr": implement.stderr,
        "verify_results": [
            {
                "command": result.command,
                "exit_code": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            for result in verify_results
        ],
        "changed_files": changed_files,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _write_loop_state(
    path: Path,
    bug_id: str,
    status: str,
    loop_reports: list[dict[str, object]],
    *,
    blocker: str = "",
    worktree_root: Path | None = None,
    worktree_branch: str = "",
) -> None:
    path.write_text(
        json.dumps(
            {
                "bug_id": bug_id,
                "status": status,
                "worktree_root": str(worktree_root) if worktree_root is not None else "",
                "worktree_branch": worktree_branch,
                "loops": loop_reports,
                "blocker": blocker,
                "updated_at": date.today().isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _update_bug_status(bug_dir: Path, status: str) -> None:
    index_path = bug_dir / "index.xml"
    root = ElementTree.fromstring(index_path.read_text(encoding="utf-8"))
    status_node = root.find("status")
    updated_at_node = root.find("updated-at")
    if status_node is None or updated_at_node is None:
        raise BugWorkflowError(f"invalid bug index xml: {index_path}")
    status_node.text = status
    updated_at_node.text = date.today().isoformat()
    index_path.write_text(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" + ElementTree.tostring(root, encoding="unicode"),
        encoding="utf-8",
    )


def _xml_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
