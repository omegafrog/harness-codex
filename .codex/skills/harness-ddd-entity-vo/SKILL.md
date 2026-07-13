---
name: harness-ddd-entity-vo
description: 이벤트 스토밍으로 DDD 후보의 Entity와 Value Object를 만들고 문서 skeleton을 작성하는 L3 skill이다.
---

# DDD Entity / Value Objects

레벨: L3.

대상 `event-storming.md`만으로 Entity/VO를 도출하고
`docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/ddd-design.md`를 만든다.

- `.codex/skills/harness-ddd-entity-vo/references/template.md`를 따른다.
- 속성·타입·필수 여부·Entity/VO 구분이 event storming에 없으면 `harness-ddd-question`이 필요한 매핑으로 반환.
- Entity는 식별성이 있을 때만, VO는 불변 값일 때만 사용.
- `status: candidate`로 시작하고 첫 단일 Mermaid flowchart를 만든다.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
