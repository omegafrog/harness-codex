---
name: harness-technical-decision-document
description: 확정된 기술 문제 해결로 ChangeSet 기술 결정 문서만 작성하는 L3 skill이다.
---

# Technical Decision Document

레벨: L3.

확정된 기술 문제·기술 기반 또는 미해결 질문과 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/technical-decisions.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-technical-decision-document/references/template.md`를 따른다.
- 사업 정책, 사용자 행위, 도메인 규칙, 용어, DDD 경계, 구현 계획을 변경하지 않는다.
- 미해결 기술 문제 또는 기술 기반 질문이 있으면 `status: needs_input`과 질문·추천안을 기록한다.
- 모든 기술 문제가 확정됐거나 `기술 문제 없음`일 때만 `status: ready`.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
