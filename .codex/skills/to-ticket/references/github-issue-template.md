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

## 명세와 다이어그램

- Product Spec: [경로]
- Architecture Spec: [경로]
- Product diagrams:
  - [이름]: ![다이어그램 이름](<ticket-scoped Product SVG URL>)
- Architecture diagrams:
  - [이름]: ![다이어그램 이름](<ticket-scoped Architecture SVG URL>)
- 적용 가능한 다이어그램이 없으면 `해당 없음 — 이유`를 기록한다.

## 의존성

[child Issue 간 blocking 관계. 없으면 `없음`]

## 검증

- Product Spec: [경로]
- Architecture Spec: [경로]
- 각 child Issue의 테스트 계약을 실행한다.

구현·검증 완료 전에는 이 Issue를 닫지 않는다.
```

필수: `Plan Set`, `목적`, `실행 순서`, `명세와 다이어그램`, `의존성`, `검증`, parent/child Issue 링크.

## Child Issue

```markdown
## 상태

Planned

## 의존성

[blocking Issue 링크 또는 `없음`]

## 구현 목적

[무엇을 구현하고 왜 필요한지]

## 범위

- workspace_root: `[실제 기존 구현 worktree 절대 경로]`
- workspace_branch: `[그 worktree의 실제 브랜치명]`
- [vertical slice 범위]

## 수용 기준

- [관찰 가능한 완료 조건]

## 테스트 계약

- 단위/정책: [업무 규칙 검증 대상; verification_files: 경로 또는 none; verification_command: 기본 CLI 명령. Parent E2E만 execution_profile을 기록]
- `ui ~ entity` E2E: [parent에는 plan-set 전체 통합 후 실행할 사용자 시나리오·oracle·profile·timeout·attempt budget; child에는 parent의 최종 E2E 참조]

## 관련 명세

- Product Spec: [경로]
- Architecture Spec: [경로]

## 다이어그램

[사용 가능한 ticket-scoped SVG 링크 또는 `해당 없음 — 이유`]
```

필수: `상태`, `의존성`, `구현 목적`, `범위`, `수용 기준`, `테스트 계약`, `관련 명세`, `다이어그램`.

## 생성 전 검증

- 각 child의 `범위` 첫 두 항목에 [실행 위치 계약](execution-evidence.md#실행-위치)의 `workspace_root`, `workspace_branch`를 기록한다. structured-source는 같은 내용을 기존 `scope` 문자열에 담는다. canonical plan·index·렌더된 Issue 값의 일치와 실제 Git 등록·브랜치를 확인한다.

- `수용 기준`에는 관련 UC/BR/INV ID, 소유 모델과 enforcement operation, 관찰 가능한 결과를 보존한다.
- Child `테스트 계약`에는 소유 UC/BR/AC의 업무 조건·행위·기대 결과를 검증하는 단위 테스트만 기록한다. 테스트 파일과 실행 프로필은 계획 자체의 테스트 계약에 기록한다. 발행 전 해당 계약이 canonical plan과 같은지 확인한다. 비즈니스 로직 변경이 없으면 경로는 `none`으로 하고 테스트를 추가하지 않는다. Parent의 `ui ~ entity E2E`에는 plan-set 전체 통합 후 마지막에 한 번 실행할 feature-level 시나리오와 oracle/profile/timeout/budget을 기록하고 child는 이를 참조한다. 성능 측정은 테스트와 별도 검증 evidence로 관련 System Target, workload·단위·baseline 수집 방법·허용 회귀·증거 위치를 연결한다. 구조 입력은 기존 `acceptance_criteria`, `test_contract.unit_policy`, `test_contract.ui_entity_e2e` 필드를 사용한다.

- parent와 child 본문을 서로 바꾸지 않는다.
- placeholder(`[... ]`, `<...>`)를 남기지 않는다.
- 모든 child Issue는 하나의 split plan만 표현한다.
- 상태는 `Planned`로 고정한다. tracker 상태가 아닌 임의 상태/label을 쓰지 않는다.
- 의존성은 실제 Issue 번호만 사용한다. 추측한 번호·경로를 만들지 않는다.
- parent의 Product/Architecture Spec 경로는 실제 존재하는 non-empty 파일이어야 한다.
- parent에 넣는 모든 SVG는 실제 존재하는 non-empty `.svg` 파일이어야 한다.
- 다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`을 기록한다.
- 본문이 비어 있거나 필수 heading이 빠지거나 위 규칙을 위반하면 GitHub mutation을 중단한다.
