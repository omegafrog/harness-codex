# harness-event-storming Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-event-storming/SKILL.md`

---
name: harness-event-storming
description: >
  Use after requirements and use cases exist to run ticketon-ddd style event
  storming through the oracle agent. The skill derives commands, events,
  policies, systems, external systems, and invariants from use cases, and
  writes docs/use-cases/<UC-ID>/event-storming.md for each affected use-case
  slice.
---

# Harness Event Storming

## Purpose

이 스킬은 active ChangeSet과 affected UC slice를 입력으로 삼아 유스케이스 기반
이벤트 스토밍을 수행한다. 산출물은 `docs/use-cases/<UC-ID>/event-storming.md`다.
`docs/design/이벤트 스토밍.md`는 전체 summary/index로만 유지할 수 있으며,
planner/executor의 직접 입력은 UC slice 파일이다.

스킬이 호출되면 `.codex/agents/oracle.toml`에 정의된 oracle 전담 에이전트에게
작업을 맡긴다. 에이전트를 찾을 수 없거나 실행할 수 없으면 대체 실행하지 말고,
이유를 설명한 뒤 멈춘다.

## Invocation

전담 에이전트:

- agent id: `oracle`
- config: `.codex/agents/oracle.toml`
- required input:
  - `docs/changes/active/<CHG-ID>.md`
  - `docs/use-cases/<UC-ID>/use-case.md`
  - `docs/use-cases/<UC-ID>/e2e-goal.md`
  - `docs/design/이벤트 스토밍.md` when present, as summary/index context only
- output file:
  - `docs/use-cases/<UC-ID>/event-storming.md`

실행 규칙:

- affected UC를 초기 커맨드로 등록한다.
- happy path를 먼저 따라가며 커맨드, 이벤트, 정책, 시스템, 외부 시스템을 추출한다.
- 예외 흐름도 별도 흐름으로 작성한다.
- 이벤트, 정책, 커맨드, 외부 시스템은 반드시 추출한다.
- 산출물 템플릿은 oracle agent instruction 안에 내장된 UC slice 템플릿을 따른다.
- oracle이 없거나 실행할 수 없으면 현재 에이전트가 대신 수행하지 않는다.
- oracle의 쓰기 범위는 `docs/use-cases/<UC-ID>/event-storming.md`와 필요 시
  summary/index인 `docs/design/이벤트 스토밍.md`로 제한한다.
- oracle은 기준 문서나 스킬 md를 읽어 실행하지 않는다.
- oracle이 읽는 md 파일은 active ChangeSet, affected UC의 `use-case.md`,
  `e2e-goal.md`, 그리고 summary/index 목적의 `docs/design/이벤트 스토밍.md`로 제한한다.
- ChangeSet 또는 affected UC slice에 비즈니스 정책 확인 필요가 남아 있으면 해당 UC의
  이벤트 스토밍을 작성하지 않고, upstream requirements/use-case blocker로 보고한다.
  이벤트 스토밍 단계에서 actor goal, success/failure policy, validation policy,
  retention/source policy, user-visible behavior를 질문하거나 확정하지 않는다.
- Event-storming drafts must be written before asking questions, and questions
  must stay inside event-storming modeling ambiguity.
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
- 이벤트 스토밍 요소는 하나의 의미만 가져야 한다. 예: `이메일이 중복되지 않고 입력
  형식이 유효한 경우`는 `이메일 중복을 검증하라`와 `입력 형식 유효성을 검증하라`로
  분리한다.
- 정책과 커맨드를 섞지 않는다. 예: `인증 정보가 유효하면 인증을 완료한다`는
  `인증 정보가 유효한 경우` 정책과 `인증을 완료하라` 커맨드로 분리한다.
- 커맨드는 시스템에 행위를 수행하라고 내리는 명령이며 명령형으로 쓴다.
- 이벤트는 도메인 안에서 발생한 사실이며 과거형으로 쓴다.
- 정책은 이벤트가 발생했을 때 다음 행동을 결정하는 규칙이다.
- 정책은 조건 또는 판단 기준으로 작성한다. 예: `이메일이 사용 가능한 경우`,
  `결제가 승인된 경우`.
- 정책은 조건 분기, 검증, 실패 가능 지점에서 특히 중요하다.
- 외부 시스템은 도메인 외부의 협력 시스템이다.

## Completion Gate

이벤트 스토밍은 아래 조건을 모두 만족해야 완료로 볼 수 있다.

- 모든 커맨드, 이벤트, 정책, 외부 시스템 요소가 각각 하나의 의미만 가진다.
- 정책과 커맨드가 한 문장에 섞여 있지 않다.
- 모든 커맨드는 명령형이다.
- 모든 이벤트는 과거형이다.
- 모든 정책은 조건 또는 판단 기준이다.

하나라도 만족하지 못하면 `docs/design/이벤트 스토밍.md`를 완료 산출물로 보고하지
말고, 어느 요소가 어떤 규칙을 위반했는지 기록한 뒤 수정하거나 질문한다.

## Interactive Runtime Contract

When invoked by runtime, every turn must return only JSON and then exit. Do not
wait for interactive stdin.

- Write or update the current `docs/use-cases/<UC-ID>/event-storming.md` draft before asking event-storming modeling questions.
- Use `needs_input` only for command, event, policy, system, external system, or invariant wording/mapping ambiguity when the approved use case already contains the business policy.
- Ask up to three focused Grill-Me questions with `question` and `recommended`.
- Ask only command, event, policy, system, external system, or invariant ambiguity questions.
- Return `blocked`, not `needs_input`, for missing actor goal, success/failure policy, validation policy, retention/source policy, user-visible behavior, or other product/business policy. Name the upstream stage.
- Do not ask aggregate, DDD architecture, or technical strategy questions; report those as downstream handoff notes or blockers.

Use this shape when user input is needed:

```json
{
  "status": "needs_input",
  "questions": [
    {
      "question": "What event-storming decision is needed?",
      "recommended": "Recommended answer based on local artifacts or inference."
    }
  ],
  "changed_files": [
    "docs/use-cases/UC-001/event-storming.md"
  ],
  "blocker": ""
}
```

Use `status: complete` only after writing the event-storming document. Use
`status: blocked` only when upstream requirements, context, or use-case inputs
are missing or contradictory.
