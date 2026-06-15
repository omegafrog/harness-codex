# harness-technical-decisions Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-technical-decisions/SKILL.md`

---
name: harness-technical-decisions
description: >
  Use after harness DDD design is complete and before implementation planning
  to decide detailed technical strategies such as polling vs push, retry and
  circuit breaker policy, outbox/inbox, idempotency, transaction boundaries,
  cache policy, observability, and adapter-level technology choices. Writes
  docs/use-cases/<UC-ID>/technical-decisions.md for ChangeSet work and requires
  approval before planning.
---

# Harness Technical Decisions

## Purpose

이 스킬은 DDD 설계가 끝난 뒤 구현 계획을 만들기 전에 세부 기술 결정을 정리한다.
selected use-case slice와 DDD 설계를 입력으로 삼아, 구현자가 바로 계획에 반영할 수
있는 기술 전략 문서를 만든다.

## Required Inputs

- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `ARCHITECTURE.md`

## Output

- `docs/use-cases/<UC-ID>/technical-decisions.md`

## Workflow

1. selected use-case slice와 DDD 설계 산출물이 모두 존재하고 비어 있지 않은지 확인한다.
2. DDD 설계의 포트/트랜잭션/BC 통신/저장 책임을 확인한다.
3. 구현에 필요한 세부 기술 결정 후보를 뽑는다.
4. 사용자가 명시하지 않은 결정은 임의 확정하지 말고 pending으로 남긴다.
5. 결정된 내용과 미결정 내용을 `docs/use-cases/<UC-ID>/technical-decisions.md`에 작성한다.
6. 모든 구현 차단 결정이 확정되면 사용자에게 최종 확인을 요청한다.
7. 사용자가 명시적으로 승인하기 전에는 `$harness-code-planner`를 실행하지 않는다.

## Decision Scope

이 단계에서 다룰 수 있는 결정:

- framework/library 선택, AOP/proxy 적용 여부, 암호화 cipher/crypto primitive 선택
- polling, push, webhook, scheduler 등 상호작용 방식
- circuit breaker, retry/backoff, timeout, bulkhead 정책
- outbox/inbox, idempotency key, 중복 처리, 메시지 순서 보장
- 트랜잭션 경계, eventual consistency, 보상 처리
- DB schema/migration 전략, repository/adapter 구현 전략
- Redis/cache 사용 위치, 기술적 cache TTL, invalidation, stampede 방지
- 메시징 topic/queue/channel 책임과 consumer 실패 처리
- 외부 API client 전략, rate limit, fallback
- 로깅, 메트릭, tracing, audit event 필드
- 테스트 범위에 영향을 주는 integration/contract/container test 전략

이 단계에서 다루면 안 되는 결정:

- actor goal, success/failure policy, user-visible behavior
- draft/image/source metadata가 필요한지 여부
- unsaved/abandoned user data를 얼마나 오래 보관할지, 언제 삭제할지, 만료/retention/cleanup 정책
- source metadata required 여부나 누락 시 사용자에게 어떤 정책을 적용할지
- 요구사항/유스케이스/DDD 경계 자체의 재결정

위 항목이 빠져 구현이 막히면 technical-decisions 질문으로 묻지 말고 upstream requirements/use-case
blocker로 보고한다. 기술 결정은 승인된 제품/비즈니스 정책을 전제로 구현 mechanism만 결정한다.

요구사항 단계에서 이미 확정했어야 하는 큰 기반 기술이 빠져 있으면 pending으로 남기고
다음 단계 gate를 막는다. 단, 이 스킬은 요구사항/유스케이스 자체를 다시 작성하지 않는다.

## Output Template

`docs/use-cases/<UC-ID>/technical-decisions.md`는 다음 구조를 따른다.

```markdown
# <UC-ID>. Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet|<CHG-ID>|
|Use Case|<UC-ID>|
|Approval Status|approved or pending|
|Approved By|user-confirmed runtime decision or pending|

## 2. Input Documents
|Document|Status|Use|
|---|---|---|

## 3. Approved Decisions
|Decision Area|Decision|Rationale|Implementation Impact|Test/Verification Impact|
|---|---|---|---|---|

## 4. Failure, Recovery, and Consistency Policy
|Situation|Policy|Retry/Compensation|Observability|Required Tests|
|---|---|---|---|---|

## 5. Planner Requirements
- Decisions planner must include:
- Decisions executor must not change:
- Tests/verification planner must include:

## 6. Slice-First External Lookup Record
|Outside Document|Why Read|Missing Slice Information|Conflict|Handling|
|---|---|---|---|---|

## 7. Pending Decisions
- None
```

## Gate

- `Pending Decisions`에 기술 mechanism 선택이 남아 있으면 planner로 넘어가지 않는다.
- `Pending Decisions`에 draft expiry, retention, cleanup, source metadata policy, user-visible behavior처럼
  upstream product/business policy가 남아 있으면 technical-decisions 질문으로 묻지 않고 blocker로 보고한다.
- `Approval Status`가 `approved`가 아니면 planner를 실행하지 않는다.
