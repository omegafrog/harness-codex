# harness-ddd-design Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-ddd-design/SKILL.md`

## Purpose

이 스킬은 하나의 Event Storming slice를 기반으로 **후보 DDD 설계**를 만든다. 코드는 생성하지 않고, 이 결과는 ChangeSet 전체의 canonical model이 아니다. 여러 Work Item 후보의 병합과 shared `ARCHITECTURE.md` 반영은 후속 `harness-ddd-integration` 단계의 책임이다.

## Invocation

- agent id: `ddd_architect`
- config: `.codex/agents/ddd_architect.toml`
- required input:
  - `docs/changes/active/<CHG-ID>.md`
  - `docs/use-cases/<UC-ID>/use-case.md`
  - `docs/use-cases/<UC-ID>/event-storming.md`
  - `docs/use-cases/<UC-ID>/e2e-goal.md`
- output file:
  - `docs/use-cases/<UC-ID>/ddd-design.md`

## Write boundary

- 쓰기 범위는 `docs/use-cases/<UC-ID>/ddd-design.md` 하나다.
- `ARCHITECTURE.md`를 수정하지 않는다.
- 다른 UC 후보나 downstream technical decision, diagram, plan을 수정하지 않는다.
- 후보 문서 상단에는 `status: candidate`, ChangeSet ID, Work Item ID, Event Storming input hash를 기록한다.

## Slice-first flow

1. active ChangeSet과 selected UC를 확인한다.
2. selected slice의 Use Case, Event Storming, E2E goal을 먼저 읽는다.
3. slice에서 부족한 baseline 정보만 canonical docs와 existing `ARCHITECTURE.md`에서 읽는다.
4. 후보 Aggregate/Entity/Value Object/command/event/state/invariant/relationship을 근거와 함께 작성한다.
5. 다른 Work Item과 공유될 수 있는 Aggregate 또는 Entity는 `Integration Impact`에 명시한다.

## Candidate rules

- 후보의 각 command, event, invariant, state transition은 UC 또는 Event Storming 근거를 남긴다.
- Entity와 VO의 속성·타입·필수 여부·검증 근거를 기록한다.
- Aggregate는 하나의 root와 원자적 일관성 경계를 가진다.
- Application service는 orchestration만 하고 business rule을 포함하지 않는다.
- 기술 stack, storage, adapter, retry, cache, transaction propagation, deployment detail은 technical-decisions 단계로 넘긴다.
- lifecycle, permission, policy, state transition을 결정할 근거가 없으면 추측하지 않고 upstream blocker로 반환한다.

## Handoff

`ddd-design-integration`은 모든 후보의 claim을 정규화해 canonical contract를 만든다. candidate 문서가 나중에 변경되면 input hash 불일치로 integration과 downstream 산출물은 stale이다.
