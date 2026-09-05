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

## Assignee 규칙

- GitHub mode의 assignee 설정은 `.codex/harness.yaml`의 `tracker.github.assignees`를 사용한다.
- `spec-me → to-ticket` 흐름에서 사용자가 요청한 plan set의 parent/child Issue는 `spec_me` 값(`@me`)을 assignee로 지정한다.
- Codex가 테스트·개발 중 추가로 만든 Issue는 `codex` 값(`@copilot`)을 assignee로 지정한다.
- 기존 Issue의 assignee는 별도 요청 없이는 변경하지 않는다.

## Pull Request 연계

- GitHub mode에서 생성·갱신하는 모든 PR은 `.codex/harness.yaml`의 `tracker.github.project_owner`와 `tracker.github.project_number` Project에 item으로 연결한다.
- plan PR은 draft로 유지한다.
- 구현 검증이 완료된 상태로 `gh-open-pr`를 호출하면 새 PR은 ready 상태로 만들고, 기존 draft PR은 `gh pr ready`로 draft를 해제한다.
- 구현 검증이 끝나지 않은 PR이나 plan PR의 draft 상태는 해제하지 않는다.
