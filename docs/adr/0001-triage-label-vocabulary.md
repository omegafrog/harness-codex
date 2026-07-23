# 0001: Triage label vocabulary

## 상태

Accepted

## 결정

이 저장소의 triage label은 `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`를 canonical role로 사용한다.

GitHub Issues의 실제 label string도 위 이름과 동일하게 유지한다.

## 이유

- `ready-for-agent`는 사람 컨텍스트 없이 AFK 에이전트가 바로 집을 수 있는 상태를 뜻한다.
- 상태 역할과 완료 상태를 섞지 않기 위해 canonical role을 고정한다.
- `approved` / `blocked` 같은 값은 triage role이 아니라 별도의 plan/flow 상태로만 다룬다.

## 영향

- `docs/agents/triage-labels.md`가 label vocabulary의 단일 출처가 된다.
- setup과 triage 관련 스킬은 이 파일을 기준으로 issue label을 관리한다.
