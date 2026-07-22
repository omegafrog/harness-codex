# Architecture Spec

## 목적

Product Spec을 구현 가능한 설계 계약으로 바꾼다.

## 입력

- 완료된 Product Spec
- `CONTEXT.md`
- `CONTEXT-MAP.md`가 있으면 함께 읽기
- 관련 ADR
- `code-research` 결과

## 진행

1. Product Spec과 guidance를 먼저 읽는다.
2. `code-research`를 호출해 현재 구조와 목표 설계의 차이를 요약받는다.
3. 별도의 `grill-with-docs` 인터뷰를 수행해 Technical Decision을 확정한다.
4. `ddd-design`과 `codebase-design`을 거쳐 Architecture Spec을 docs/specs 아래에 작성한다.

## Technical Decision 인터뷰

`grill-with-docs`는 한 번에 하나의 결정만 질문한다. Architecture Spec을 작성하기 전에 아래 항목을 훑고, Product Spec, 기존 ADR, `code-research` 결과만으로 확정되지 않은 항목은 반드시 질문한다.

- 경계: bounded context, aggregate, module/package 책임이 어디서 갈리는가.
- 일관성: 강한 일관성이 필요한 규칙과 eventual consistency가 허용되는 흐름은 무엇인가.
- 트랜잭션: transaction boundary는 어디이며 rollback 대상은 무엇인가.
- 통합: 외부 시스템, adapter, port, API 계약은 무엇인가.
- 상태와 저장: 새 상태, 기존 상태 변경, migration, idempotency 요구는 무엇인가.
- 실패 처리: retry, compensation, partial failure, timeout, duplicate handling은 어떻게 되는가.
- 운영: observability, audit, permissions, rollout, backfill 필요는 무엇인가.
- 테스트 계약: unit, integration, contract, regression test로 고정할 결정은 무엇인가.

각 질문은 추천안을 포함한다. 결정이 hard-to-reverse이면 `grill-with-docs` 흐름에 따라 ADR로 남긴다.

## 완료 조건

- 미결정 설계 사항이 남아 있으면 완료하지 않는다.
- Technical Decision 인터뷰 항목마다 `결정됨`, `해당 없음`, `Product Spec/ADR로 이미 확정됨` 중 하나로 판정된다.
- 코드와 요구사항의 불일치를 숨기지 않는다.
- Product Spec에서 이미 확정된 사실을 다시 묻지 않는다.
- 코드 조사 원문은 Architecture Spec 본문에 길게 남기지 않는다.
- `docs/specs/architecture-spec.md`에 `references/template.md` 형식으로 문서가 생성된다.
- 기존 `docs/specs/architecture-spec.md`는 명시적 승인 없이 덮어쓰지 않는다.
