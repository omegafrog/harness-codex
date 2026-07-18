---
name: harness-deferred-findings
description: orchestrator가 W7 범위 밖 finding의 사용자 disposition을 기록하고 승인된 GitHub Issue를 생성하거나 재사용할 때 호출한다.
---

# Deferred Findings

레벨: L2.

입력은 reviewer가 반환한 stable finding ID·근거·위험과 사용자가 선택한 disposition이다.
쓰기 범위는 `docs/changes/active/<CHG-ID>/deferred-findings.md` 하나다.

1. 각 finding에 `accepted_scope | follow_up_changeset | github_issue` 중 하나를 기록한다.
2. `accepted_scope`는 사용자 승인 근거가 있어야 resolved다.
3. `follow_up_changeset`은 후보 범위와 사용자 선택을 기록하고 새 ChangeSet을 자동 생성하지 않는다.
4. `github_issue`는 사용자 승인이 있을 때만 `scripts/create_issue.py --user-approved`를 호출한다.
5. 같은 repository·ChangeSet·finding marker의 Issue가 있으면 URL을 재사용한다.
6. unresolved finding이 하나라도 있으면 문서 `status: needs_input`, 모두 resolved면 `status: ready`다.

제품 코드, plan, review, wiki를 수정하거나 다른 agent를 spawn하지 않는다. Issue 생성 실패는
`blocked`와 원인을 반환한다. 호출 종료 후 token 추정을 출력한다.
