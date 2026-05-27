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
- 엔티티는 식별이 필요한 객체다.
- VO는 값을 나타내는 불변 객체이며 생성 시점에 규칙을 검증한다.
- 엔티티와 VO는 생성자에서 도메인 규칙을 평가해야 한다.
- 메서드는 도메인 행동을 나타내며, 자기 상태를 수정하거나 자기 상태만 검증하는
  경우에만 내부 메서드로 둔다.
- 외부 협력 객체가 필요한 행동은 애플리케이션 서비스가 협력 결과를 파라미터로
  전달하거나 도메인 서비스로 분리한다.
- 어그리거트는 원자적으로 변경되어야 할 엔티티/VO 경계다.
- 어그리거트는 루트 엔티티를 가지며, 루트 메서드로만 내부 값을 변경한다.
- setter나 하위 객체 직접 변경은 금지한다.
- 애플리케이션 서비스는 유스케이스 오케스트레이션을 담당하며, 비즈니스 로직을
  직접 구현하지 않는다.
- 애플리케이션 서비스는 selected UC의 단일 `ddd-design.md` 안에 작성한다.
- BC는 변경 전파 범위와 같은 도메인 용어의 다른 모델 표현 여부로 결정한다.
- 설계 차원에 영향을 주는 미결정 사항은 추정해서 산출물에 반영하지 않는다.

## Interactive UI Substeps

- UI 실행에서는 하나의 호출이 하나의 substep만 완료한다:
  `entity_vo`, `behaviors`, `application_flow`, `aggregates`, `bounded_contexts`.
- 같은 `docs/use-cases/<UC-ID>/ddd-design.md`를 점진적으로 확장하며 앞 단계 섹션을 보존한다.
- `entity_vo`는 기존 완료 DDD 문서와 `ARCHITECTURE.md`를 우선 확인하고, 부족할 때만 구현 코드를 읽어 `new`, `modify`, `reuse`를 판정한다.
- 모든 모델/서비스/경계는 command, event, policy 중 하나 이상의 근거를 기록한다.
- BC 통신 방식은 `internal_http`, `domain_event`, `shared_database` 중 하나만 사용한다. `internal_http`는 공개 client/API 경계이며 다른 BC 내부 모델 직접 호출이 아니다.
