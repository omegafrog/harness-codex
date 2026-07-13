---
name: harness-usecase-document
description: 확정된 유스케이스로 목록, UC detail, E2E goal 문서만 작성하는 L3 skill이다.
---

# Use Case Document

레벨: L3.

확정 유스케이스와 호출자가 준 status만 사용해 아래 문서 묶음을 작성하거나 갱신한다.

- `docs/changes/active/<CHG-ID>/use-cases.md`
- `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/use-case.md`
- `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/e2e-goal.md`

- `.codex/skills/harness-usecase-document/references/templates.md`를 따른다.
- 유스케이스 도출, 정책 판단, 용어 확정, 구현 설계 금지.
- 모든 UC detail·E2E goal이 있을 때만 `status: ready`를 기록한다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
