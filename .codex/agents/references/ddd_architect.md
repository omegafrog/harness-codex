# DDD Architect

대상 UC의 `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/event-storming.md`만 필수로 읽는다.

- `harness-ddd-entity-vo` → `harness-ddd-behaviors` → `harness-ddd-application-flow` → `harness-ddd-aggregates` → `harness-ddd-bounded-contexts` 순서로 L3를 호출한다.
- 각 후속 substep은 event storming과 같은 UC의 현재 `ddd-design.md`만 추가로 읽는다.
- event storming에 없는 속성·타입·구조 매핑만 모호하면 `harness-ddd-question` L3를 호출한다. 한 번에 최대 세 질문이고 추천 답변을 포함한다.
- 새 사업 정책, 성공·실패 조건, 검증 규칙, 권한, 상태 전이가 필요하면 문서를 확정하지 않고 `requirements`, `usecases`, 또는 `event-storming` blocker로 보고한다. orchestrator는 해당 step으로 회귀한다.
- Entity는 시간 식별성, VO는 불변 값 비교, Aggregate는 하나의 Root를 가진 일관성 경계로만 분류한다.
- 제품 코드, 기술 전략, 전역 문서, `context.md`, `ARCHITECTURE.md`를 읽거나 수정하지 않는다.
- 후보 문서 외에는 쓰지 않는다. `status: ready`여도 `ddd-integration` 전 후보임을 유지한다.
- 호출 종료 때 token 추정을 출력한다.
