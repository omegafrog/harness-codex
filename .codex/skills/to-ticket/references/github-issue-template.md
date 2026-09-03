# GitHub Issue 본문 템플릿

`to-ticket`이 GitHub mode에서 생성하는 Issue는 아래 두 형식만 사용한다. 대괄호 placeholder는 실제 값으로 치환한다.

## Parent Issue

```markdown
## Plan Set

- Product/Architecture Spec: [#SPEC]
- Child plans: [#CHILD-ISSUES]

## 목적

[이 계획 세트가 해결하는 문제와 기대 결과]

## 실행 순서

1. [#CHILD] — [요약]

## 의존성

[child Issue 간 blocking 관계. 없으면 `없음`]

## 검증

- Product Spec: [경로]
- Architecture Spec: [경로]
- 각 child Issue의 테스트 계약을 실행한다.

구현·검증 완료 전에는 이 Issue를 닫지 않는다.
```

필수: `Plan Set`, `목적`, `실행 순서`, `의존성`, `검증`, parent/child Issue 링크.

## Child Issue

```markdown
## 상태

Planned

## 의존성

[blocking Issue 링크 또는 `없음`]

## 구현 목적

[무엇을 구현하고 왜 필요한지]

## 범위

- [vertical slice 범위]

## 수용 기준

- [관찰 가능한 완료 조건]

## 테스트 계약

- 단위/정책: [검증 대상]
- `ui ~ entity` E2E: [시나리오 또는 현재 환경 제약]

## 관련 명세

- Product Spec: [경로]
- Architecture Spec: [경로]

## 다이어그램

[사용 가능한 ticket-scoped SVG 링크 또는 `해당 없음 — 이유`]
```

필수: `상태`, `의존성`, `구현 목적`, `범위`, `수용 기준`, `테스트 계약`, `관련 명세`, `다이어그램`.

## 생성 전 검증

- parent와 child 본문을 서로 바꾸지 않는다.
- placeholder(`[... ]`)를 남기지 않는다.
- 모든 child Issue는 하나의 split plan만 표현한다.
- 상태는 `Planned`로 고정한다. tracker 상태가 아닌 임의 상태/label을 쓰지 않는다.
- 의존성은 실제 Issue 번호만 사용한다. 추측한 번호·경로를 만들지 않는다.
- 다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`을 기록한다.
- 본문이 비어 있거나 필수 heading이 빠지거나 위 규칙을 위반하면 GitHub mutation을 중단한다.
