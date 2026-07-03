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

## Language Contract

- 사용자에게 보이는 모든 출력은 한국어로 작성한다.
- `technical-decisions.md`의 제목, 섹션 heading, 표 라벨, 결정명, 근거, 구현 영향, 테스트 영향, blocker, pending 질문, recommended answer는 한국어여야 한다.
- 파일 경로, 코드 식별자, JSON key, CLI command, protocol name, library/framework name, 런타임 호환 metadata key는 필요한 경우 원문을 보존한다.
- 런타임 호환을 위해 metadata row key `Approval Status`와 status value `approved`, `pending`은 번역하지 않는다.
- `needs_input` JSON을 반환할 때 `question`과 `recommended` 값은 코드/라이브러리/프로토콜명을 제외하고 한국어로 작성한다.

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

- framework/library 선택, middleware 도입 여부, AOP/proxy 적용 여부, 암호화 cipher/crypto primitive 선택
- layered/hexagonal adapter 구현, CQRS, event-driven integration, outbox/inbox, synchronous adapter call 같은 구현 메커니즘용 architecture pattern 선택
- persistence technology, database engine/storage family, DB schema/migration 도구, repository adapter 기술, DB lock policy
- concurrency control, transaction boundary, isolation level, durable save mechanics, idempotency key, 중복 처리, message ordering
- retry/backoff, timeout, circuit breaker, bulkhead, rate limit, fallback, queue/stream consumer 실패 처리 같은 resilience middleware와 정책
- Redis/cache 도입 여부, 기술적 cache TTL, invalidation, stampede 방지
- 구현 계획에 필요한 runtime/deployment/build/bootstrap 기술
- observability tooling과 테스트 범위에 영향을 주는 integration/contract/container test 전략

이 단계에서 다루면 안 되는 결정:

- actor goal, success/failure policy, user-visible behavior
- draft/image/source metadata가 필요한지 여부
- unsaved/abandoned user data를 얼마나 오래 보관할지, 언제 삭제할지, 만료/retention/cleanup 정책
- source metadata required 여부나 누락 시 사용자에게 어떤 정책을 적용할지
- module placement, package/directory placement, ownership reshuffling
- external access path, endpoint route, navigation path, actor-facing entrypoint
- business data collection method, collection timing, collection source, domain flow sequencing
- 요구사항/유스케이스/DDD 경계 자체의 재결정

위 항목이 빠져 구현이 막히면 technical-decisions 질문으로 묻지 말고 upstream requirements/use-case
blocker로 보고한다. 단, 승인된 requirements, use case, event storming, DDD evidence, E2E goal이 해당
동작을 명시적으로 요구하는 경우에만 "빠진 정책"으로 판단한다. 승인된 slice에 없는 abandoned draft,
orphan asset, retention, deletion, expiry, cleanup lifecycle을 가정해서 blocker나 pending decision을
만들면 안 된다. 범위 밖 가상 상태는 제외하거나 그 상태를 만들지 않는 구현 mechanism을 선택한다.
기술 결정은 승인된 제품/비즈니스 정책을 전제로 구현 mechanism만 결정한다.
accepted DDD integration, 승인된 use-case flow, event-storming policy, ubiquitous-language meaning은
불변 계약으로 취급한다. `or`를 `and`로, `any`를 `all`로, `one or more`를 `all`로, 데이터 부재를
조회 실패로 바꾸는 식의 의미 축소/확대/재작성은 금지한다. 도메인 분류 규칙과 상태 라벨 의미는
기술 선택이 아니며, 기술결정 문서에서는 upstream 정본을 그대로 인용하고 구현 메커니즘만 결정한다.
모듈 배치, 외부 접근 경로, 수집 방식은 기술결정 문서의 결정 후보로 올리지 않는다. 이런 내용이
필요하면 승인된 DDD/design/planning 입력을 따르고, 입력이 모순되면 해당 upstream stage blocker로
보고한다.

요구사항 단계에서 이미 확정했어야 하는 큰 기반 기술이 빠져 있으면 pending으로 남기고
다음 단계 gate를 막는다. 단, 이 스킬은 요구사항/유스케이스 자체를 다시 작성하지 않는다.

## Output Template

`docs/use-cases/<UC-ID>/technical-decisions.md`는 다음 구조를 따른다.
출력 문서에는 verifier placeholder term을 literal로 남기지 않는다. 입력 문서에 미해결 placeholder가
있었다고 설명해야 할 때도 placeholder term 자체를 인용하지 말고 "unresolved placeholder"처럼
서술한다.

```markdown
# <UC-ID>. 기술 결정

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet|<CHG-ID>|
|Use Case|<UC-ID>|
|Approval Status|approved or pending|
|승인 근거|사용자 확인 런타임 결정 또는 pending|

## 2. 입력 문서
|문서|상태|사용 목적|
|---|---|---|

## 3. 승인된 결정
|결정 영역|결정|근거|구현 영향|테스트/검증 영향|
|---|---|---|---|---|

## 4. 실패, 복구, 일관성 정책
|상황|정책|재시도/보상|관측성|필수 테스트|
|---|---|---|---|---|

## 5. 계획 작성 요구사항
- 계획 작성자가 포함해야 할 결정:
- 구현 실행자가 변경하면 안 되는 결정:
- 테스트/검증 계획에 포함해야 할 항목:

## 6. Slice 우선 외부 조회 기록
|외부 문서|조회 이유|Slice에 없던 정보|충돌|처리|
|---|---|---|---|---|

## 7. 보류 중인 결정
- 없음
```

## Gate

- `Pending Decisions`에 기술 mechanism 선택이 남아 있으면 planner로 넘어가지 않는다.
- `Pending Decisions`에 draft expiry, retention, cleanup, source metadata policy, user-visible behavior처럼
  upstream product/business policy가 남아 있으면 technical-decisions 질문으로 묻지 않고 blocker로 보고한다.
- 위 blocker는 승인된 slice가 해당 동작을 명시적으로 요구한다는 정확한 evidence를 포함해야 한다.
  승인된 slice에 없는 abandoned-draft/orphan-asset lifecycle은 blocker 또는 pending으로 추가하지 않는다.
- `Approval Status`가 `approved`가 아니면 planner를 실행하지 않는다.
