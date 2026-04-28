---
name: harness-ddd-design
description: >
  Use after event storming exists to design DDD components without generating
  code. The skill runs the ddd_architect agent to derive domain models,
  aggregates, bounded contexts, application services, domain services, and
  communication maps from docs/design/이벤트 스토밍.md through staged outputs.
  After each DDD design stage it must stop and get user confirmation before
  continuing to the next canonical docs/design/details/*.md design file.
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
  - `docs/design/이벤트 스토밍.md`
  - `docs/design/유스케이스.md`
  - `docs/design/요구사항.md` when present
- output files:
  - `docs/design/details/도메인모델.md`
  - `docs/design/details/어그리거트.md`
  - `docs/design/details/애플리케이션서비스.md`
  - `docs/design/details/바운디드컨텍스트.md`
  - `docs/design/details/index.md`

실행 규칙:

- 기준 문서나 스킬 md를 읽어 실행하지 않는다.
- DDD 설계 기준과 산출물 템플릿은 ddd_architect agent instruction 안에 내장된
  템플릿을 따른다.
- 읽는 md 파일은 작업 입력인 `docs/design/이벤트 스토밍.md`,
  `docs/design/유스케이스.md`, `docs/design/요구사항.md`로만 제한한다.
- 코드, 테스트, 패키지 구조, 구현 파일을 만들지 않는다.
- 쓰기 범위는 `docs/design/details` 아래의 다섯 산출물 파일로만 제한한다.
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
- DDD 설계는 단계별로 진행한다. 각 단계 산출물을 작성한 뒤 사용자에게 요약을 보여주고
  명시적 승인을 받을 때까지 다음 단계 파일을 작성하지 않는다.

## Staged Approval Flow

단계 순서:

1. 도메인 모델 설계
   - output: `docs/design/details/도메인모델.md`
   - 완료 후 사용자 확인을 받기 전까지 어그리거트 설계로 넘어가지 않는다.
2. 어그리거트 설계
   - required approval: 도메인 모델 승인
   - output: `docs/design/details/어그리거트.md`
   - 완료 후 사용자 확인을 받기 전까지 애플리케이션 서비스 설계로 넘어가지 않는다.
3. 애플리케이션 서비스 설계
   - required approval: 어그리거트 승인
   - output: `docs/design/details/애플리케이션서비스.md`
   - 완료 후 사용자 확인을 받기 전까지 바운디드 컨텍스트 설계로 넘어가지 않는다.
4. 바운디드 컨텍스트 설계
   - required approval: 애플리케이션 서비스 승인
   - output: `docs/design/details/바운디드컨텍스트.md`
   - 완료 후 사용자 확인을 받기 전까지 인덱스 작성으로 넘어가지 않는다.
5. 인덱스 작성
   - required approval: 바운디드 컨텍스트 승인
   - output: `docs/design/details/index.md`

사용자가 명시적으로 "승인", "진행", "다음 단계로"처럼 다음 단계 진행 의사를 밝힌
경우에만 다음 단계로 재개한다. 승인 없이 한 번의 호출에서 여러 단계 파일을 연속으로
작성하지 않는다.

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
- 애플리케이션 서비스는 `애플리케이션서비스.md`에 별도로 작성한다.
- BC는 변경 전파 범위와 같은 도메인 용어의 다른 모델 표현 여부로 결정한다.
- 설계 차원에 영향을 주는 미결정 사항은 추정해서 산출물에 반영하지 않는다.
