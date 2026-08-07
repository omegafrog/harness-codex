# 이슈 트래커

이 저장소의 이슈 트래커는 GitHub Issues다.

## 역할

- 새 작업은 GitHub issue로 만든다.
- 라벨과 상태는 issue tracker에서 관리한다.
- 로컬 markdown issue를 기본 경로로 쓰지 않는다.

## 관리 규칙

- `gh` 기준으로 생성, 갱신, 라벨 변경을 한다.
- 하나의 plan은 하나의 issue에 대응시킨다.
- issue 본문에는 범위, 검증, 의존성, AFK 가능 여부를 적는다.

## 이 저장소 기준

- repo remote가 GitHub이므로 GitHub Issues를 기본 tracker로 쓴다.
- `ready-for-agent`는 issue 라벨 중 하나로 다룬다.
- Issue의 `ready-for-agent` label은 대응 plan의 `status`와 동기화한다. GitHub Project를 사용하면 표시 상태도 plan 상태와 동기화한다. Project의 `Planned` column만 바꾸고 label을 남겨두면 실행 가능 상태로 간주하지 않는다.
- `approved` / `blocked`는 triage label이 아니라면 issue 라벨로 쓰지 않는다.
