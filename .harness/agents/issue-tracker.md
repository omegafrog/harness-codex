# 이슈 트래커

이 저장소의 이슈 트래커는 setup이 `.harness/harness.yaml`의 `tracker.mode`으로 선택한다.

## 역할

- `github` mode는 GitHub Issue와 설정된 GitHub Project만 사용한다.
- `local-markdown` mode는 설정된 로컬 ticket 파일만 사용한다.
- 선택하지 않은 configured tracker에는 ticket, 상태, 의존성을 기록하거나 갱신하지 않는다. `tracker-publish`가 선택한 tracker에 ticket을 발행하고, `tactical-code`와 `implement`는 lifecycle 상태를 `harness-tracker.mjs sync`로 갱신한다.

## 관리 규칙

- 모든 mode의 정본 상태는 로컬 plan Issue `docs/plans/<plan-set>/<plan-id>.md`의 `status` frontmatter (`planned`, `in-progress`, `blocked`, `completed`)다. GitHub Project `Workflow Status` (`Planned`, `In Progress`, `Blocked`, `Done`)와 GitHub Issue는 보조 mirror다. split plan은 검증 완료 시 로컬에서 `completed`로 바꾸고 GitHub child Issue는 plan-set integration PR이 merge될 때까지 열어 둔다.
- GitHub mode에서는 로컬 plan 상태를 먼저 기록하고 configured Project field와 기본 `Status`를 best-effort mirror로 동기화한다. mirror 갱신·검증 실패는 로컬 상태를 되돌리거나 완료를 차단하지 않는다. child Issue는 PR merge 전까지 `OPEN`이어야 한다.
- local-markdown mode의 상태는 ticket 파일의 `planned`, `in-progress`, `blocked`, `completed`로 관리한다.
- 구현 계획 문서는 범위와 검증 계약만 담으며 tracker 상태가 아니다.

## 이 저장소 기준

- GitHub mode는 repository마다 `repository`, `project_owner`, `project_number`를 `.harness/harness.yaml`에 기록한다. 다른 repository의 Project를 추측·공유하지 않는다.

## Assignee 규칙

- GitHub mode의 assignee 설정은 `.harness/harness.yaml`의 `tracker.github.assignees`를 사용한다.
- `tactical-to-code`의 `to-ticket → tracker-publish` 흐름은 사용자의 직접 발행 승인(`--approval-answer`)을 받은 뒤에만 Project draft를 만들고 Issue로 전환한다. ticket 한 개를 구현하는 `tactical-code`는 시작 때 로컬 plan Issue를 `in-progress`로, 검증 완료 뒤 `completed`로 바꾸며 이 frontmatter 변경을 해당 ticket commit에 포함한다. GitHub mode도 동일하게 로컬 상태를 정본으로 쓰고 외부 상태는 best-effort로 동기화한다. `to-ticket → tracker-publish` 흐름에서 사용자가 요청한 plan set의 parent/child Issue는 `spec_me` 값(`@me`)을 assignee로 지정한다. 키 이름 `spec_me`는 이미 소비자의 `.harness/harness.yaml`에 저장된 설정이라 workflow 폐기 뒤에도 바꾸지 않는다. 소비자 설정을 옮기는 migration이 생길 때 함께 바꾼다.
- Codex가 테스트·개발 중 추가로 만든 Issue는 `codex` 값(`@copilot`)을 assignee로 지정한다.
- 기존 Issue의 assignee는 별도 요청 없이는 변경하지 않는다.

## Pull Request 연계

- GitHub mode에서 생성·갱신하는 모든 PR은 `.harness/harness.yaml`의 `tracker.github.project_owner`와 `tracker.github.project_number` Project에 item으로 연결한다.
- 구현 PR은 대상 parent/child Issue를 PR 본문의 `Closes #<ISSUE-NUMBER>` closing keyword로 연결한다. 본문 단순 참조, 제목 참조, Project item 연결은 Linked Issue를 대신하지 않는다.
- 구현 PR 생성·갱신 후 `gh pr view <PR-NUMBER> --json closingIssuesReferences`로 모든 대상 Issue 연결을 검증한다. 누락 시 본문을 보정하고 `gh pr edit` 후 재검증한다.
- plan PR은 draft로 유지한다.
- 구현 검증이 완료된 상태로 `gh-open-pr`를 호출하면 새 PR은 ready 상태로 만들고, 기존 draft PR은 `gh pr ready`로 draft를 해제한다.
- 구현 검증이 끝나지 않은 PR이나 plan PR의 draft 상태는 해제하지 않는다.

## 새 mirror 상태의 단일 실행 경계

lifecycle 상태는 [상태 계약](plan-status.md)의 `harness-tracker.mjs sync`로 갱신·재조회한다. 보드는 Workflow Status로 그룹화하고 기본 Status 열은 표시에서 숨기는 것을 권장한다. backlog는 분류, test/review는 단계 metadata이며 tracker 상태가 아니다.
