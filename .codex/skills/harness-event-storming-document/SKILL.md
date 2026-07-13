---
name: harness-event-storming-document
description: 확정된 이벤트 스토밍 모델로 UC slice 문서만 작성하는 L3 skill이다.
---

# Event Storming Document

레벨: L3.

확정된 모델과 호출자가 준 status만 사용해
`docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/event-storming.md`만 작성하거나 갱신한다.

- `.codex/skills/harness-event-storming-document/references/template.md`를 따른다.
- 유스케이스 도출, 사업 정책 판단, 용어 확정, DDD 설계, 기술 전략 결정 금지.
- 모든 요소가 단일 의미이고, 커맨드는 명령형, 이벤트는 과거형, 정책은 조건 또는 판단 기준일 때만 `status: ready`.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력.
