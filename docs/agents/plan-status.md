# Tracker 상태 계약

## Canonical 상태

선택된 tracker만 상태를 저장한다. 구현 plan 문서는 상태 source가 아니다.

- `planned`: 승인 전이거나, 승인되었지만 의존성 또는 blocker 때문에 아직 실행할 수 없음
- `in-progress`: `implement`가 현재 실행 중
- `completed`: 구현·검증·상태 정리 완료
- `blocked`: 명시적인 blocker로 진행 불가

GitHub mode는 Project `Planned`, `In Progress`, `Blocked`, `Done`을 사용한다. local-markdown mode는 위 소문자 상태를 ticket 파일에 기록한다.

## 상태 전이

```text
planned --(implement 시작)--> in-progress
in-progress --(구현·검증 성공)--> completed
in-progress --(blocker 발생)--> blocked
completed --(모든 의존성 해소)--> dependent planned ticket을 재평가
```

## 책임

- `to-ticket`: 선택된 tracker에 ticket과 dependency를 만들고 `planned`로 둔다.
- `implement`: 선택된 tracker에서 시작 ticket을 `in-progress`로 만들고, 성공 시 `completed`로 만든다.
- 사람: 승인, 요구사항·설계 결정, 외부 blocker만 처리한다. 정상적인 상태 전이는 사람이 수동으로 수행하지 않는다.

## 실행 가능성 불변식

실행할 ticket은 반드시 다음을 만족한다.

- 승인 완료
- 모든 dependency가 `completed`
- 구현 목적·범위·acceptance criteria·test contract 존재
- blocker 없음
- 선택된 tracker에서 `planned` 상태

실행 가능 조건을 만족하는 plan을 `planned`로 남기면 workflow 오류다.
