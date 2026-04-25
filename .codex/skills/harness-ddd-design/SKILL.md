---
name: harness-ddd-design
description: >
  Use after event storming exists to design DDD components without generating
  code. The skill runs the ddd_architect agent to derive domain models,
  aggregates, bounded contexts, application services, domain services, and
  communication maps from docs/design/이벤트 스토밍.md and writes the canonical
  docs/design/details/*.md design files.
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
- 상세 DDD 설계 전에 비즈니스 정책 미결정과 기술 결정 미결정을 검사한다.
- 비즈니스 정책 미결정이 남아 있으면 요구사항~이벤트 스토밍 단계로 되돌려야 하므로
  설계를 작성하지 않고 멈춘다.
- 기술 결정 미결정이 도메인 모델, 어그리거트, BC, 애플리케이션 서비스, 트랜잭션,
  저장, 외부 협력, 장애 복구, 성능/운영 책임에 영향을 주면 설계를 작성하지 않고
  멈춘다.

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
