---
name: harness-plan-document
description: 확정된 ChangeSet 구현 계획을 체크박스 문서로 작성하는 L3 skill이다.
---

# Plan Document

레벨: L3.

확정 구현 계획과 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/plan.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-plan-document/references/template.md`를 따른다.
- 모든 구현 작업은 `- [ ]`로 시작한다. implementation agent가 나중에 검증 통과 작업만 `- [x]`로 갱신한다.
- 도메인 정책, 기술 결정, DDD 설계, 제품 코드를 변경하지 않는다.
- 모든 작업이 실행 가능할 때만 `status: ready`.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
