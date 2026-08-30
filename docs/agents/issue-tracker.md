# 이슈 트래커

이 저장소의 이슈 트래커는 setup이 `.codex/harness.yaml`의 `tracker.mode`으로 선택한다.

## 역할

- `github` mode는 GitHub Issue와 설정된 GitHub Project만 사용한다.
- `local-markdown` mode는 설정된 로컬 ticket 파일만 사용한다.
- 선택하지 않은 tracker에는 ticket, 상태, 의존성을 기록하거나 갱신하지 않는다.

## 관리 규칙

- GitHub mode의 상태는 setup이 확인·구성한 GitHub Project `Workflow Status` (`Planned`, `In Progress`, `Blocked`, `Done`)로 관리한다. `Done`이면 Issue를 Close한다.
- local-markdown mode의 상태는 ticket 파일의 `planned`, `in-progress`, `blocked`, `completed`로 관리한다.
- 구현 계획 문서는 범위와 검증 계약만 담으며 tracker 상태가 아니다.

## 이 저장소 기준

- GitHub mode는 repository마다 `repository`, `project_owner`, `project_number`를 `.codex/harness.yaml`에 기록한다. 다른 repository의 Project를 추측·공유하지 않는다.
