---
name: harness-technical-decisions
description: >
  Use after harness DDD design is complete and before implementation planning
  to decide detailed technical strategies such as polling vs push, retry and
  circuit breaker policy, outbox/inbox, idempotency, transaction boundaries,
  cache policy, observability, and adapter-level technology choices. Writes
  docs/design/기술결정.md and requires user confirmation before planning.
---

# Harness Technical Decisions

## Purpose

이 스킬은 DDD 설계가 끝난 뒤 구현 계획을 만들기 전에 세부 기술 결정을 정리한다.
요구사항 단계에서 확정한 기반 기술과 DDD 설계를 입력으로 삼아, 구현자가 바로 계획에
반영할 수 있는 기술 전략 문서를 만든다.

## Required Inputs

- `docs/design/요구사항.md`
- `docs/design/유스케이스.md`
- `docs/design/이벤트 스토밍.md`
- `docs/design/details/index.md`
- `docs/design/details/도메인모델.md`
- `docs/design/details/어그리거트.md`
- `docs/design/details/애플리케이션서비스.md`
- `docs/design/details/바운디드컨텍스트.md`

## Output

- `docs/design/기술결정.md`

## Workflow

1. DDD 설계 산출물이 모두 존재하고 비어 있지 않은지 확인한다.
2. 요구사항의 기반 기술 결정을 읽고, DDD 설계의 포트/트랜잭션/BC 통신/저장 책임을
   확인한다.
3. 구현에 필요한 세부 기술 결정 후보를 뽑는다.
4. 사용자가 명시하지 않은 결정은 임의 확정하지 말고 질문한다.
5. 결정된 내용과 미결정 내용을 `docs/design/기술결정.md`에 작성한다.
6. 모든 구현 차단 결정이 확정되면 사용자에게 최종 확인을 요청한다.
7. 사용자가 명시적으로 승인하기 전에는 `$harness-code-planner`를 실행하지 않는다.

## Decision Scope

이 단계에서 다룰 수 있는 결정:

- polling, push, webhook, scheduler 등 상호작용 방식
- circuit breaker, retry/backoff, timeout, bulkhead 정책
- outbox/inbox, idempotency key, 중복 처리, 메시지 순서 보장
- 트랜잭션 경계, eventual consistency, 보상 처리
- DB schema/migration 전략, repository/adapter 구현 전략
- Redis/cache 사용 위치, TTL, invalidation, stampede 방지
- 메시징 topic/queue/channel 책임과 consumer 실패 처리
- 외부 API client 전략, rate limit, fallback
- 로깅, 메트릭, tracing, audit event 필드
- 테스트 범위에 영향을 주는 integration/contract/container test 전략

요구사항 단계에서 이미 확정했어야 하는 큰 기반 기술이 빠져 있으면 먼저 사용자에게
확인한다. 단, 이 스킬은 요구사항/유스케이스 자체를 다시 작성하지 않는다.

## Output Template

`docs/design/기술결정.md`는 다음 구조를 따른다.

```markdown
# 기술 결정

## 1. 입력 문서
|문서|상태|비고|
|---|---|---|

## 2. 기반 기술 결정
|항목|결정|근거|미결정 여부|
|---|---|---|---|

## 3. 세부 기술 결정
|영역|결정|근거|영향받는 설계/유스케이스|대안|미결정 여부|
|---|---|---|---|---|---|

## 4. 실패/복구/일관성 정책
|상황|정책|보상/재시도|관측성|테스트 필요성|
|---|---|---|---|---|

## 5. 구현 계획 반영 사항
- planner가 반드시 반영할 기술 결정:
- executor가 임의로 바꾸면 안 되는 결정:
- 테스트/검증에 포함할 결정:

## 6. 사용자 최종 확인
- 승인 상태: 대기
- 승인자:
- 승인 일시:
- 승인 메모:

## 7. 확인 필요
- ...
```

## Gate

- `확인 필요`에 구현 범위, 저장/통신/트랜잭션/복구/관측성에 영향을 주는 항목이
  남아 있으면 planner로 넘어가지 않는다.
- `사용자 최종 확인`의 승인 상태가 승인으로 바뀌거나, 대화에서 사용자가 명시적으로
  승인하기 전에는 planner를 실행하지 않는다.
