---
name: harness-event-storming
description: >
  Use after requirements and use cases exist to run ticketon-ddd style event
  storming through the oracle agent. The skill derives commands, events,
  policies, systems, external systems, and invariants from use cases, and
  writes the single canonical docs/design/이벤트 스토밍.md file.
---

# Harness Event Storming

## Purpose

이 스킬은 `docs/design/유스케이스.md`를 입력으로 삼아 유스케이스 기반 이벤트
스토밍을 수행한다. 산출물은 `docs/design/이벤트 스토밍.md` 단일 파일이다.

스킬이 호출되면 `.codex/agents/oracle.toml`에 정의된 oracle 전담 에이전트에게
작업을 맡긴다. 에이전트를 찾을 수 없거나 실행할 수 없으면 대체 실행하지 말고,
이유를 설명한 뒤 멈춘다.

## Invocation

전담 에이전트:

- agent id: `oracle`
- config: `.codex/agents/oracle.toml`
- required input:
  - `docs/design/유스케이스.md`
  - `docs/design/요구사항.md` when present
- output file:
  - `docs/design/이벤트 스토밍.md`

실행 규칙:

- 유스케이스를 초기 커맨드로 등록한다.
- happy path를 먼저 따라가며 커맨드, 이벤트, 정책, 시스템, 외부 시스템을 추출한다.
- 예외 흐름도 별도 흐름으로 작성한다.
- 이벤트, 정책, 커맨드, 외부 시스템은 반드시 추출한다.
- 산출물 템플릿은 oracle agent instruction 안에 내장된 템플릿을 따른다.
- oracle이 없거나 실행할 수 없으면 현재 에이전트가 대신 수행하지 않는다.
- oracle의 쓰기 범위는 `docs/design/이벤트 스토밍.md`로만 제한한다.
- oracle은 기준 문서나 스킬 md를 읽어 실행하지 않는다.
- oracle이 읽는 md 파일은 작업 입력인 `docs/design/유스케이스.md`와
  `docs/design/요구사항.md`로만 제한한다.
- 요구사항/유스케이스에 비즈니스 정책 확인 필요가 남아 있으면 이벤트 스토밍을
  작성하지 않고, 어떤 정책 때문에 막혔는지 설명하고 멈춘다.
- 기반 기술 결정 확인 필요는 커맨드/이벤트/정책/외부 시스템/불변식에 영향을 주지
  않는 경우에만 이벤트 스토밍의 확인 필요로 이월할 수 있다.
- polling, circuit breaker, retry/backoff, outbox/inbox, cache TTL 같은 세부 구현
  전략은 이벤트 스토밍 차단 조건이 아니며 DDD 이후 `harness-technical-decisions`
  단계로 넘긴다.

## Embedded Event Storming Standards

- 이벤트 스토밍은 스테이크홀더가 공통 언어를 확정하고 이벤트, 커맨드, 정책을
  확정하는 과정이다.
- 유스케이스를 시작점으로 삼아 시스템 로직 진행 중 발생하는 이벤트, 커맨드, 정책,
  시스템, 외부 시스템을 나열한다.
- 커맨드는 시스템에 행위를 수행하라고 내리는 명령이며 명령형으로 쓴다.
- 이벤트는 도메인 안에서 발생한 사실이며 과거형으로 쓴다.
- 정책은 이벤트가 발생했을 때 다음 행동을 결정하는 규칙이다.
- 정책은 조건 분기, 검증, 실패 가능 지점에서 특히 중요하다.
- 외부 시스템은 도메인 외부의 협력 시스템이다.
