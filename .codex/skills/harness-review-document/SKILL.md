---
name: harness-review-document
description: ChangeSet review gate 결과만 작성하는 L3 skill이다.
---

# Review Document

레벨: L3.

확정 review 결과와 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/review.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-review-document/references/template.md`를 따른다.
- `ready`는 모든 gate 통과일 때만 사용한다.
- 실패하면 `blocked`와 최소 blocker를 기록한다.
- 제품 코드, tests, plan, DDD 설계, 기술 결정을 수정하지 않는다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
