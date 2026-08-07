# Plan 상태 계약

## Canonical 상태

Plan 문서의 `status`는 다음 값만 사용한다.

- `planned`: 승인 전이거나, 승인되었지만 의존성 또는 blocker 때문에 아직 실행할 수 없음
- `ready-for-agent`: 승인 완료, 의존성 해소, 구현자가 추가 질문 없이 실행 가능
- `in-progress`: `implement`가 현재 실행 중
- `completed`: 구현·검증·상태 정리 완료
- `blocked`: 명시적인 blocker로 진행 불가

`pending`은 사용하지 않는다. GitHub Project의 `Planned` 표시가 있다면 plan 문서의 `planned`와 같은 의미로 취급한다.

실행 source of truth는 plan 문서의 `status`와 대응 Issue의 `ready-for-agent` label이다. GitHub Project status는 표시용이며, 사용 중이면 이 두 값과 동기화한다.

## 상태 전이

```text
planned --(승인 + 실행 가능)--> ready-for-agent
planned --(승인 + 의존성/blocker 존재)--> planned 또는 blocked
ready-for-agent --(implement 시작)--> in-progress
in-progress --(구현·검증 성공)--> completed
in-progress --(blocker 발생)--> blocked
completed --(모든 의존성 해소)--> dependent planned plan을 ready-for-agent로 전환
```

## 책임

- `to-ticket`: 티켓과 plan 생성 후 전체 plan을 평가한다. 의존성 없는 실행 가능 plan은 즉시 `ready-for-agent`로 만들고, 나머지는 `planned`로 둔다.
- `implement`: 시작 plan을 `in-progress`로 만들고, 성공 시 `completed`로 만든다. 이후 모든 dependent plan을 재평가해 실행 가능 plan을 `ready-for-agent`로 만든다.
- 사람: 승인, 요구사항·설계 결정, 외부 blocker만 처리한다. 정상적인 상태 전이는 사람이 수동으로 수행하지 않는다.

## 실행 가능성 불변식

`ready-for-agent` plan은 반드시 다음을 만족한다.

- 승인 완료
- 모든 dependency가 `completed`
- 구현 목적·범위·acceptance criteria·test contract 존재
- blocker 없음
- 대응 Issue에 `ready-for-agent` triage label 존재

실행 가능 조건을 만족하는 plan을 `planned`로 남기면 workflow 오류다.
