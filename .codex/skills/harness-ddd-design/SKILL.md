---
name: harness-ddd-design
description: >
  Use after event storming exists to design DDD components without generating
  code. The skill runs the ddd_architect agent to derive domain models,
  aggregates, bounded contexts, application services, domain services, and
  communication maps from the selected use-case slice. The selected slice
  event-storming document is the primary source; outside/canonical documents are
  fallback only for information missing from the slice.
---

# Harness DDD Design

## Purpose

이 스킬은 이벤트 스토밍 산출물을 기반으로 DDD 구성요소를 설계한다. 코드는 생성하지
않고, 설계 문서만 작성한다.

스킬이 호출되면 `.codex/agents/ddd_architect.toml`에 정의된 전담 에이전트에게
작업을 맡긴다. 에이전트를 찾을 수 없거나 실행할 수 없으면 대체 실행하지 말고,
이유를 설명한 뒤 멈춘다.

## Invocation

전담 에이전트:

- agent id: `ddd_architect`
- config: `.codex/agents/ddd_architect.toml`
- required input:
  - `docs/changes/active/<CHG-ID>.md`
  - `docs/use-cases/<UC-ID>/use-case.md`
  - `docs/use-cases/<UC-ID>/event-storming.md`
  - `docs/use-cases/<UC-ID>/e2e-goal.md`
  - canonical docs only when the selected slice lacks needed information
- output files:
  - `docs/use-cases/<UC-ID>/ddd-design.md`
  - `ARCHITECTURE.md`

실행 규칙:

- 기준 문서나 스킬 md를 읽어 실행하지 않는다.
- DDD 설계 기준과 산출물 템플릿은 ddd_architect agent instruction 안에 내장된
  템플릿을 따른다.
- ChangeSet 작업에서는 먼저 selected slice 문서
  `docs/use-cases/<UC-ID>/use-case.md`,
  `docs/use-cases/<UC-ID>/event-storming.md`,
  `docs/use-cases/<UC-ID>/e2e-goal.md`를 읽는다.
- slice에서 찾을 수 없는 정보만 외부/canonical 문서에서 검색해 읽는다.
- `docs/design/이벤트 스토밍.md`는 summary/index일 수 있으므로
  executor-facing source로 사용하지 않는다.
- 코드, 테스트, 패키지 구조, 구현 파일을 만들지 않는다.
- 쓰기 범위는 `docs/use-cases/<UC-ID>/ddd-design.md`와 `ARCHITECTURE.md`로만 제한한다.
- 각 산출물 파일은 단일하게 유지하고, 이미 있으면 기존 파일을 수정한다.
- 상세 DDD 설계 전에 비즈니스 정책 미결정과 기반 기술 결정 미결정을 검사한다.
- 비즈니스 정책 미결정이 남아 있으면 요구사항~이벤트 스토밍 단계로 되돌려야 하므로
  설계를 작성하지 않고 멈춘다.
- 기반 기술 결정 미결정이 도메인 모델, 어그리거트, BC, 애플리케이션 서비스,
  저장소 계열, 외부 협력 포트, 메시징 사용 여부처럼 DDD 구조에 영향을 주면 설계를
  작성하지 않고 멈춘다.
- polling 방식, circuit breaker, retry/backoff, outbox/inbox 구현, cache TTL,
  세부 transaction propagation 같은 구현 전략은 DDD 설계를 막지 않는다. 필요한
  후보와 설계상 제약만 `확인 필요`에 남기고 DDD 이후 `harness-technical-decisions`
  단계에서 확정한다.
- DDD 설계는 selected UC에 필요한 도메인 모델, 어그리거트, 애플리케이션 서비스,
  바운디드 컨텍스트, 아키텍처 제약을 한 slice 문서에 모은다.
- 산출물에는 확정된 모델, 경계, 책임, 관계, 불변식, 확인 필요, 그리고 외부 문서 사용
  기록만 남긴다.

## Slice-First Flow

1. active ChangeSet을 읽어 selected UC를 확인한다.
2. selected UC slice의 `use-case.md`, `event-storming.md`, `e2e-goal.md`를 먼저 읽는다.
3. slice만으로 DDD 설계가 가능하면 외부 문서를 읽지 않는다.
4. slice에 없는 정보만 canonical docs에서 검색해 읽는다.
5. `docs/use-cases/<UC-ID>/ddd-design.md`와 `ARCHITECTURE.md`를 작성/갱신한다.

## Embedded DDD Design Standards

- 도메인 모델은 이벤트, 커맨드, 정책으로부터 도출한다.
- Entity means an object with identity across time.
- Value object means an immutable value compared by value and validated at creation time.
- Entity / VO output must define attributes, types, required/optional state, and validation evidence.
- Method means domain behavior. Keep it inside one entity/value object only when it changes or validates only that object's own state.
- Behavior needing external collaboration belongs in an application service orchestration or domain service, not inside an entity.
- Entity/VO visualization must show only the `entity` or `vo` tag, model name, attribute names, and method signatures.
- Entity/VO methods must not be visualized as separate cards; separate behavior nodes are only for domain services.
- Aggregate means an atomic consistency boundary of entities and VOs.
- Aggregate has one root entity; only root methods mutate internals.
- Setters and direct child mutation are forbidden.
- Application service orchestrates use cases and must not contain business rules.
- Application service stays inside the selected UC's single `ddd-design.md`.
- BC is decided by change propagation boundary and different model meanings for the same domain term.
- Do not guess unresolved decisions that affect architecture shape.

## Interactive UI Substeps

- UI execution completes only one substep per invocation:
  `entity_vo`, `behaviors`, `application_flow`, `aggregates`, `bounded_contexts`.
- Extend the same `docs/use-cases/<UC-ID>/ddd-design.md` and preserve completed prior sections.
- `entity_vo` first checks completed DDD documents and `ARCHITECTURE.md`; read source code only as fallback evidence for `new`, `modify`, or `reuse`.
- `entity_vo` rows must map each model to one `Impact Assessment` row whose `Element Type` is only `Entity` or `Value Object`; lifecycle `Status` such as `new`, `modify`, or `reuse` is never a visual model tag.
- `behaviors` keeps entity/value-object method signatures owned by the matching model; only domain services may be rendered or described as separate behavior nodes.
- Every model, service, aggregate, and boundary must record command, event, or policy evidence.
- BC communication must use exactly one of `internal_http`, `domain_event`, or `shared_database`. `internal_http` means public client/API boundary, not direct calls into another BC's internal model.
