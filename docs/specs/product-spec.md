# Product Spec

## 1. Problem and Context

티켓의 split plan을 구현할 때 메인 세션이 직접 구현하거나, 경량 컨텍스트의 단일 서브에이전트가 장시간 작업하면서 컨텍스트 한계를 넘어 품질이 저하될 수 있다. plan별 구현 책임은 서브에이전트가 갖되, 메인 세션은 실행 조정·대기·충돌 라우팅을 담당하는 wrapper workflow가 필요하다.

## 2. Goals and Desired Outcomes

- 승인된 plan을 plan 단위로 서브에이전트에게 위임한다.
- 의존성이 없고 공유 자원 충돌이 없는 plan은 병렬 실행한다.
- 각 plan에는 동시에 하나의 실행 슬롯만 둔다.
- 컨텍스트 한계 전에 진행 상태를 보존하고 새 서브에이전트가 같은 plan을 재개할 수 있게 한다.
- 구현, 테스트, review, blocker 해소가 끝난 plan만 완료로 처리한다.
- 충돌 발생 시 메인 세션이 우선순위를 판단하고 실행 순서를 라우팅한다.

## 3. Users and Actors

- **메인 세션**: plan을 분배하고, 병렬 실행을 조정하며, 충돌 우선순위를 결정한다.
- **구현 서브에이전트**: `implement` 과정에 따라 하나의 plan을 구현·검증하고 blocker를 해결한다.
- **티켓 작성자**: 승인된 plan, 의존성, 범위와 완료 조건을 제공한다.

## 4. Ubiquitous Language and Terminology

| Term | Definition |
| --- | --- |
| wrapper skill | `implement`를 plan별 서브에이전트 실행, handoff, 재개, 충돌 라우팅으로 감싸는 실행 스킬 |
| 실행 슬롯 | 하나의 plan에 동시에 허용되는 구현 실행 단위. plan당 최대 하나 |
| checkpoint | 컨텍스트 교체 후 작업을 재개하기 위한 무시된 실행 상태 기록 |
| handoff | 현재 서브에이전트가 checkpoint를 남기고 동일 plan을 다음 서브에이전트에 넘기는 행위 |
| blocker | 현재 승인 범위 안에서 즉시 완료할 수 없게 만드는 문제 |
| 환경 차단 | 자격 증명, 외부 서비스, 시드 데이터 등 저장소 외부 상태가 필요한 blocker |
| plan 충돌 | 병렬 plan이 동일 파일·상태·작업을 변경하거나 Git 충돌을 일으키는 상황 |

## 5. Core Use Cases

### UC-01. Plan 위임 실행

메인 세션은 실행 가능한 plan마다 하나의 서브에이전트를 시작한다. 서브에이전트는 해당 plan의 `implement` 절차를 수행한다.

### UC-02. 독립 plan 병렬 실행

메인 세션은 plan에 선언된 의존성과 공유 자원을 확인한다. 독립적이고 충돌 가능성이 없는 plan은 동시에 실행한다. 불확실하면 순차 실행한다.

### UC-03. Blocker 해결 반복

서브에이전트는 blocker의 원인을 분석하고 수정·검증을 반복한다. 외부 결정·권한·의존성·환경 변경이 필요한 경우에만 메인 세션에 중단 사유와 정확한 unblock condition을 보고한다.

### UC-04. Context Handoff 및 재개

서브에이전트는 컨텍스트 잔여량이 안전 임계치에 도달하거나 주요 단계가 끝났을 때 checkpoint를 기록한다. wrapper는 같은 plan의 새 서브에이전트를 시작하고 checkpoint, plan, spec, Git/test 상태를 대조해 작업을 재개한다.

### UC-05. Plan 충돌 라우팅

병렬 실행 중 예상하지 못한 파일·Git 충돌이 발생하면 관련 plan을 중단한다. 메인 세션은 plan 우선순위를 판단하고, 우선 plan을 먼저 실행한 뒤 나머지 plan을 재개한다. 자동 병합이나 자동 우선순위 결정은 하지 않는다.

### UC-06. Plan 완료 판정

구현·plan별 테스트·typecheck·code review에 unresolved blocker가 없을 때만 plan을 완료한다. 환경 차단은 코드 완료와 구분하여 보고한다.

## 6. Business Rules and Invariants

- BR-01: 실행 대상은 승인되고 실행 가능한 plan이어야 한다.
- BR-02: 하나의 plan에는 동시에 하나의 실행 슬롯만 존재한다.
- BR-03: plan 의존성이 완료되지 않으면 해당 plan을 실행하지 않는다.
- BR-04: 공유 자원 충돌 가능성이 있거나 병렬 가능 여부가 불확실하면 순차 실행한다.
- BR-05: 메인 세션은 구현 코드를 직접 수정하지 않고 조정·대기·충돌 라우팅을 담당한다.
- BR-06: handoff는 작업 중단이 아니라 동일 plan의 실행 컨텍스트 교체다.
- BR-07: checkpoint 경로는 `docs/plans/.runtime/<plan-id>/checkpoint.md`로 고정하고 Git에서 무시한다.
- BR-08: 새 서브에이전트 프롬프트에는 checkpoint 경로를 명시해야 한다.
- BR-09: 실제 Git/test 상태와 checkpoint가 다르면 실제 상태를 우선하고 checkpoint를 보정한다.
- BR-10: 충돌 plan은 메인 세션의 우선순위 판단 전까지 재개하지 않는다.
- BR-11: review가 끝나지 않았거나 unresolved blocker가 있으면 plan을 완료 처리하지 않는다.

## 7. States and State Transitions

```text
planned -> in-progress -> handoff-required -> in-progress
in-progress -> blocked -> in-progress
in-progress -> conflict-paused -> priority-routed -> in-progress
in-progress -> completed
```

`blocked`는 외부 결정·권한·의존성·환경 변경이 필요할 때만 사용한다. `conflict-paused`는 메인 세션의 우선순위 라우팅이 필요한 상태다.

## 8. Failures, Exceptions, and Boundary Conditions

- 컨텍스트 잔여량이 위험 수준이면 현재 시도와 다음 작업을 checkpoint에 남기고 handoff한다.
- 테스트·review·명령 실행이 실패하면 서브에이전트가 원인을 분석하고 범위 안에서 계속 수정한다.
- 외부 환경이 필요하면 환경 차단으로 보고하고 정확한 unblock condition을 남긴다.
- checkpoint와 실제 상태가 다르면 실제 상태를 기준으로 복구한다.
- 병렬 plan이 충돌하면 자동 병합하지 않고 관련 plan을 중단한다.
- 메인 세션이 우선순위를 정할 수 없는 경우 사용자 결정이 필요한 blocker로 보고한다.

## 9. Inputs and Outputs

### Inputs

- `docs/plans/plans.md`와 개별 plan 문서
- Product/Architecture Spec
- plan 의존성 및 공유 자원 정보
- 현재 Git 상태와 테스트 결과
- `docs/plans/.runtime/<plan-id>/checkpoint.md`

### Outputs

- 구현 및 검증된 plan
- 선택된 tracker 상태 갱신
- handoff·blocker·충돌 기록
- 메인 세션에 대한 최종 결과, 미해결 blocker, 다음 실행 가능 plan 보고

## 10. Scope and Non-goals

### Scope

- `implement` 실행을 plan별 서브에이전트에 위임
- 독립 plan 병렬 실행
- checkpoint 기반 context handoff 및 재개
- blocker 반복 해결과 충돌 우선순위 라우팅

### Non-goals

- wrapper가 구현 코드를 직접 수정하는 것
- plan 범위를 자동으로 확장하는 것
- 충돌을 자동 병합하거나 우선순위를 자동 결정하는 것
- 외부 자격 증명·서비스·시드 데이터를 자동으로 제공하는 것

## 11. Priorities and Trade-offs

1. 구현 품질과 plan 범위 준수
2. blocker가 해소될 때까지의 지속성
3. 안전한 병렬 처리
4. 실행 속도

컨텍스트 교체와 충돌 시 순차 재실행은 속도를 낮출 수 있지만, 장기 컨텍스트 압축으로 인한 품질 저하와 자동 충돌 병합의 범위 이탈을 방지한다.

## 12. Success Conditions and Acceptance Criteria

- AC-01: 각 실행 가능한 plan이 정확히 하나의 실행 슬롯에서 수행된다.
- AC-02: 독립 plan은 병렬 실행되고, 의존 plan은 선행 plan 완료 후 실행된다.
- AC-03: 서브에이전트는 blocker를 범위 내에서 해결·검증한 뒤에만 완료를 보고한다.
- AC-04: 컨텍스트 handoff 후 새 서브에이전트가 checkpoint 경로를 통해 작업을 재개한다.
- AC-05: checkpoint는 `docs/plans/.runtime/` 아래에 저장되고 Git에서 무시된다.
- AC-06: plan 충돌 시 관련 실행이 멈추고 메인 세션의 우선순위에 따라 재실행된다.
- AC-07: 구현·테스트·typecheck·review에 unresolved blocker가 있으면 완료 상태가 되지 않는다.
- AC-08: 메인 세션은 구현 변경을 직접 수행하지 않는다.
