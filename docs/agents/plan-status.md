# Tracker 상태 계약

## 상태 source

선택된 tracker만 상태를 저장한다.

- `github` mode: parent Issue는 전체 작업을, child Issue는 split plan을 나타낸다. child Issue의 GitHub Project `Workflow Status`가 상태 source다.
- `local-markdown` mode: ticket 파일의 상태가 source다. plan 문서는 구현 계약과 실행 기록을 보조한다.

## Canonical 상태

- `planned`: 승인 전이거나, 승인되었지만 dependency 또는 blocker 때문에 실행할 수 없음
- `in-progress`: 구현자가 현재 실행 중
- `completed`: 구현·검증·상태 정리 완료
- `blocked`: 명시적인 blocker로 진행 불가

GitHub mode 매핑:

| Canonical 상태 | GitHub Project `Workflow Status` |
|---|---|
| `planned` | `Planned` |
| `in-progress` | `In Progress` |
| `blocked` | `Blocked` |
| `completed` | `Done` + child Issue closed |

local-markdown mode는 위 canonical 상태를 ticket 파일에 그대로 기록한다.

## 실행 가능성

별도 상태값 `ready-for-agent`를 저장하지 않는다. 다음 조건을 모두 만족하면 실행 가능으로 계산한다.

- 승인 완료
- 모든 dependency가 `completed`
- 구현 목적·범위·acceptance criteria·test contract 존재
- blocker 없음
- GitHub mode에서는 대응 child Issue가 parent Issue에 연결됨

GitHub mode에서 실행 가능 plan은 Project `Planned` 상태를 유지하며, `implement`가 선택해 `In Progress`로 전환한다.

## 상태 전이

```text
planned --(승인 + 실행 가능)--> in-progress
planned --(blocker 존재)--> blocked
in-progress --(구현·검증 성공)--> completed
in-progress --(blocker 발생)--> blocked
completed --(dependency 해소)--> dependent planned ticket 재평가
```

## 책임

- `to-ticket`: GitHub mode에서는 parent/child Issue와 dependency를 만들고, local-markdown mode에서는 ticket·plan과 dependency를 만든다. 모두 `planned`로 초기화한다.
- `implement`: 실행 가능한 ticket 하나를 선택해 `in-progress`로 전환하고, 성공 시 `completed`로 전환한다. 이후 dependent ticket을 재평가한다.
- 사람: 승인, 요구사항·설계 결정, 외부 blocker만 처리한다. 정상적인 상태 전이는 수동으로 수행하지 않는다.

## 불변식

- 하나의 split plan은 하나의 child Issue 또는 하나의 local ticket에 대응한다.
- GitHub mode의 child Issue 본문은 split plan 본문이다.
- parent Issue와 child Issue 연결은 `docs/plans/plans.md`를 대체한다.
- 선택하지 않은 tracker에는 상태·dependency를 기록하지 않는다.
- 실행 가능 조건을 만족하는 ticket을 `planned`로 방치하지 않는다.
