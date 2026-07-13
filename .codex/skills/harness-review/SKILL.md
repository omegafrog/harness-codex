---
name: harness-review
description: Harness 메인 워크플로우에서 완료된 ChangeSet 구현의 검증·DDD·기술결정·경로 gate를 검토하는 L2 step이다.
---

# Review

레벨: L2.

`reviewer` agent를 호출한다. 정본 지침은 `.codex/agents/references/reviewer.md`다.

- `plan.md`의 모든 작업이 `- [x]`일 때만 review한다.
- agent는 plan 검증 명령을 다시 실행하고, DDD 설계·기술 결정·선언 경로를 검토한다.
- `harness-review-document` L3가 `docs/changes/active/<CHG-ID>/review.md`만 쓴다.
- 실패면 코드·plan을 수정하지 않고 `status: blocked`와 blocker를 반환한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
