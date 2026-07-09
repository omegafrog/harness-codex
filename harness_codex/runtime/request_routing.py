"""초기 오케스트레이션 요청을 ChangeSet 또는 bug workflow로 분류한다."""

from __future__ import annotations

import re
from dataclasses import dataclass


BUG_HINTS = (
    "버그",
    "bug",
    "에러",
    "error",
    "exception",
    "실패",
    "failure",
    "깨짐",
    "고장",
    "오류",
    "회귀",
    "재현",
    "증상",
    "incident",
    "outage",
)

BUG_ACTIONS = (
    "수정",
    "고쳐",
    "해결",
    "fix",
    "repair",
    "resolve",
    "처리",
)

ISSUE_PATTERN = re.compile(r"(?:#\d+|\d+번\s*이슈|issue\s*#?\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class InitialRequestRoute:
    workflow: str
    title: str
    summary: str
    reason: str


def classify_initial_request(prompt: str) -> InitialRequestRoute:
    normalized = " ".join(prompt.strip().split())
    if not normalized:
        raise ValueError("initial prompt is required")
    lowered = normalized.lower()
    hint_hits = [token for token in BUG_HINTS if token.lower() in lowered]
    action_hits = [token for token in BUG_ACTIONS if token.lower() in lowered]
    issue_hit = ISSUE_PATTERN.search(normalized)
    if hint_hits or (issue_hit and action_hits):
        return InitialRequestRoute(
            workflow="bug",
            title=normalized[:80],
            summary=normalized,
            reason=(
                f"bug_hints={hint_hits or '-'}; "
                f"bug_actions={action_hits or '-'}; "
                f"issue_ref={issue_hit.group(0) if issue_hit else '-'}"
            ),
        )
    return InitialRequestRoute(
        workflow="changeset",
        title=normalized[:80],
        summary=normalized,
        reason=(
            f"bug_hints={hint_hits or '-'}; "
            f"bug_actions={action_hits or '-'}; "
            f"issue_ref={issue_hit.group(0) if issue_hit else '-'}"
        ),
    )
