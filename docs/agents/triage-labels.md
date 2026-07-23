# Triage Labels

이 저장소는 canonical triage role을 그대로 쓴다.

## Canonical roles

- `needs-triage` - 아직 검토 전
- `needs-info` - 추가 정보 필요
- `ready-for-agent` - 사람 컨텍스트 없이 에이전트가 바로 집을 수 있음
- `ready-for-human` - 사람이 직접 처리해야 함
- `wontfix` - 처리하지 않음

## 매핑

이 저장소에서는 별도 별칭을 두지 않는다.

| Canonical role | Label string |
|---|---|
| `needs-triage` | `needs-triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `wontfix` | `wontfix` |

## 관리 규칙

- 한 issue는 한 시점에 하나의 triage role만 가진다.
- `ready-for-agent`는 완료 상태가 아니다.
- 구현 완료 후에는 plan 상태를 `completed`로 바꾸고, triage role은 제거하거나 다른 role로 바꾼다.
- `approved` / `blocked`는 이 저장소의 canonical triage role이 아니다.
