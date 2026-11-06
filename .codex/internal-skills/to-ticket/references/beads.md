# Beads 티켓 미러

선택된 configured tracker가 티켓 상태의 canonical source이며 Beads는 같은 parent/child 계획을 반영하는 작업 보드다. 일반 Beads task lifecycle과 v1 mirror 상태 동기화는 [공용 Beads 스킬](../../beads/GUIDE.md)을 따른다.

## Publisher stage 준비

현재 plan-review gate pass 뒤 별도 `tracker-publish` stage가 `workspace_root`에서 `bd version`, `bd where`, `bd status`를 실행해 CLI와 workspace 상태를 확인한다. 초기화가 필요한 경우 `$setup`으로 준비를 완료한 뒤 이어간다. `.codex/harness.yaml`에서 configured tracker mode를 읽는다. GitHub mode에서는 이 단계에서 Beads tracker mirror를 만들지 않는다. Project draft는 구현 시작 시 실제 Issue로 변환한 뒤 mirror한다.

## 계획 티켓 작성

GitHub mode에서는 계획 단계의 Beads tracker mirror 생성을 건너뛴다. local-markdown mode에서는 기존대로 parent와 child를 생성한다.

GitHub mode에서 아래 작업은 Issue conversion 뒤 수행한다. parent는 `epic`으로 만들고 child 생성에 `--parent <beads-parent-id>`를 지정한다. 각 Beads description에 제목·구현 목적·범위·UC/BR/AC 업무 규칙 단위 테스트 계약·`verification_files`·직접 실행할 `verification_command`를 담는다. Parent plan-set만 feature E2E `execution_profile`을 담는다. `bd dep add <beads-ticket-id> <depends-on-beads-id>`로 plan 의존성을 기록한다.

## Tracker 연결과 lifecycle

GitHub Project draft 발행 뒤 Project에서 Project item ID와 plan ID mapping을 조회하며 `tracker_sync.ticket_refs`는 빈 배열로 둔다. 구현 시작 시 Issue로 변환한 뒤 Beads 항목에 Issue URL 기반 `external_ref`와 `harness_tracker_version=1`, `harness_classification=committed`, `harness_phase=planning` metadata를 연결한다. 이후 `tracker_sync.ticket_refs`에 parent와 실제로 변환된 child의 `owner/repo#number`를 담는다. Dependency edge와 GitHub parent-child 관계는 Issue conversion 후 생성·검증한다.

`tracker-publish` workflow stage는 GitHub mode에서 Project draft items를 만들고, local-markdown mode에서 parent/child 티켓과 Beads 항목을 함께 만든다. GitHub lifecycle 상태 동기화는 Issue conversion 뒤 공용 Beads 스킬의 v1 mirror 절차를 사용한다.
