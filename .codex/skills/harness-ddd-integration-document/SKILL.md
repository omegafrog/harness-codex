---
name: harness-ddd-integration-document
description: 통합된 다중 UC 후보 DDD로 ChangeSet DDD architecture 문서만 작성하는 L3 skill이다.
---

# DDD Integration Document

레벨: L3.

통합된 후보 DDD와 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/ddd-architecture.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-ddd-integration-document/references/template.md`를 따른다.
- 후보의 의미·정책을 확장하거나 구현·기술 전략을 결정하지 않는다.
- 단일 Mermaid flowchart와 모든 합쳐진 섹션이 있을 때만 `status: ready`.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
