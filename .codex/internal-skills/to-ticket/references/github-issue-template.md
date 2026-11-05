# GitHub Issue 본문 템플릿

`to-ticket`이 GitHub mode에서 만드는 Project draft item은 아래 두 형식으로 작성한다. 구현을 시작할 때 Project draft를 저장소 Issue로 변환한다. 대괄호 placeholder는 계획 단계에서 확인 가능한 실제 값으로 치환한다.

제목과 목적은 사람이 작업 결과와 이유를 바로 이해할 수 있도록 쓴다. 수용 기준은 사용자 행동과 관찰 결과를 먼저 쓰고 UC/BR/AC 식별자는 문장 끝에 둔다. 실행 위치와 토큰 예산은 본문 뒤의 접이식 실행 정보에 보존한다. 원본 계획의 모든 필수 테스트와 비테스트 검증을 보존한다. 상위·선행 계획은 canonical plan ID로 연결하며 미게시 명세를 접근 가능한 링크처럼 표시하지 않는다.

## Parent Issue

```markdown
## 목적

[이 계획 세트가 해결하는 문제와 기대 결과]

## Plan Set

- Parent plan: [parent plan ID]
- Child plans: [child plan IDs]

## 실행 순서

1. [child plan ID] — [요약]

## 명세와 다이어그램

- Product Spec: [경로]
- Architecture Spec: [경로]
- Product diagrams:
  - [이름]: ![다이어그램 이름](<ticket-scoped Product SVG URL>)
- Architecture diagrams:
  - [이름]: ![다이어그램 이름](<ticket-scoped Architecture SVG URL>)
- 적용 가능한 다이어그램이 없으면 `해당 없음 — 이유`를 기록한다.

## 의존성

[child plan 간 blocking 관계. 없으면 `없음`]

## 검증

- Product Spec: [경로]
- Architecture Spec: [경로]
- 각 child plan의 테스트 계약을 실행한다.

구현·검증 완료 전에는 이 Issue를 닫지 않는다.
```

필수: `Plan Set`, `목적`, `실행 순서`, `명세와 다이어그램`, `의존성`, `검증`, parent/child plan ID.

## Child Issue

```markdown
## 구현 목적

[무엇을 구현하고 왜 필요한지]

## 관련 이슈

- 상위 계획: [parent plan ID]

## 상태

Planned

## 의존성

[blocking plan ID 또는 `없음`]

## 범위

- [vertical slice 범위]

## 수용 기준

- [관찰 가능한 완료 조건]

## 테스트 계약

- 단위/정책: [업무 규칙 검증 대상; verification_files: 경로 또는 none; verification_command: 기본 CLI 명령. Parent E2E만 execution_profile을 기록]
- `ui ~ entity` E2E: [parent에는 plan-set 전체 통합 후 실행할 사용자 시나리오·oracle·profile·timeout·attempt budget; child에는 parent의 최종 E2E 참조]

## 필요한 비테스트 검증

[canonical plan에 명시된 모든 검증 또는 `없음`]

## 관련 명세

- Product Spec: [경로]
- Architecture Spec: [경로]

## 다이어그램

[사용 가능한 ticket-scoped SVG 링크 또는 `해당 없음 — 이유`]

<details><summary>실행 정보</summary>

[실행기가 발행용 본문에 생성하는 실행 정보. agent는 경로·브랜치를 작성하지 않는다.]

</details>
```

필수: `상태`, `의존성`, `구현 목적`, `범위`, `수용 기준`, `테스트 계약`, `관련 명세`, `다이어그램`, plan ID.

## 작성하면서 적용할 규칙

아래 규칙은 별도 사후 검증 단계가 아니라 각 템플릿 필드를 채울 때 적용한다.

- 실행 위치는 [실행 위치 계약](execution-evidence.md#실행-위치)에 따라 정적 실행기가 생성한다. canonical plan·index·structured-source에 agent가 경로를 복사하지 않는다. publisher는 정적 준비기의 `publication_drafts` 본문 파일을 그대로 사용한다.

- `수용 기준`에는 관련 UC/BR/INV ID, 소유 모델과 enforcement operation, 관찰 가능한 결과를 보존한다.
- Child `테스트 계약`에는 소유 UC/BR/AC의 업무 조건·행위·기대 결과를 검증하는 단위 테스트만 기록한다. 테스트 파일과 실행 프로필은 계획 자체의 테스트 계약에 기록한다. 발행 전 해당 계약이 canonical plan과 같은지 확인한다. 비즈니스 로직 변경이 없으면 경로는 `none`으로 하고 테스트를 추가하지 않는다. Parent의 `ui ~ entity E2E`에는 plan-set 전체 통합 후 마지막에 한 번 실행할 feature-level 시나리오와 oracle/profile/timeout/budget을 기록하고 child는 이를 참조한다. 성능 측정은 테스트와 별도 검증 evidence로 관련 System Target, workload·단위·baseline 수집 방법·허용 회귀·증거 위치를 연결한다. 구조 입력은 기존 `acceptance_criteria`, `test_contract.unit_policy`, `test_contract.ui_entity_e2e` 필드를 사용한다.
- 구조 입력의 비테스트 검증은 `verification` 문자열 배열에 기록한다. 기존 입력에는 이 필드가 없어도 된다.

- parent와 child 본문을 서로 바꾸지 않는다.
- placeholder(`[... ]`, `<...>`)를 남기지 않는다.
- 모든 child Issue는 하나의 split plan만 표현한다.
- 상태는 `Planned`로 고정한다. tracker 상태가 아닌 임의 상태/label을 쓰지 않는다.
- Project draft 상태는 `Planned`로 설정한다. 저장소 Issue 상태는 이 단계에서 만들지 않는다.
- 의존성은 canonical plan ID를 사용한다. Issue 번호·URL을 추측하지 않는다.
- parent의 Product/Architecture Spec 경로는 실제 존재하는 non-empty 파일이어야 한다.
- parent에 넣는 모든 SVG는 실제 존재하는 non-empty `.svg` 파일이어야 한다.
- 다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`을 기록한다.
- 필수 필드의 실제 값이 아직 없으면 해당 본문 작성을 보류한다. 필드를 채운 뒤 본문 전체를 별도로 다시 검증하지 않는다.
