# Beads 티켓 미러

선택된 configured tracker가 티켓 상태의 canonical source이며 Beads는 같은 parent/child 계획을 반영하는 작업 보드다. 일반 Beads task lifecycle과 v1 mirror 상태 동기화는 [공용 Beads 스킬](../../beads/SKILL.md)을 따른다.

## Finalization 준비

현재 plan-review gate pass 뒤 `workspace_root`에서 `bd version`, `bd where`, `bd status`를 실행해 CLI와 workspace 상태를 확인한다. 초기화가 필요한 경우 `$setup`으로 준비를 완료한 뒤 이어간다. `.codex/harness.yaml`에서 configured tracker mode를 읽어 parent/child 관계와 mirror metadata를 결정한다.

## 계획 티켓 작성

Beads parent와 child를 기존 항목에서 찾아 재사용하거나 생성한다. `harness_plan_id`는 parent에 `<plan-set-id>:parent`, child에 `<plan-set-id>:<plan-id>` 형식으로 부여한다. 각 실제 값을 넣어 `bd list --all --json --metadata-field 'harness_plan_id=<실제 값>'`를 조회해 단일 일치 항목을 재사용하고, 결과가 없으면 새로 만든다. 중복 결과는 정리한 뒤 이어간다.

GitHub mode의 parent는 `epic`으로 만들고 child 생성에 `--parent <beads-parent-id>`를 지정한다. 각 Beads description에 제목·구현 목적·범위·UC/BR/AC 업무 규칙 단위 테스트 계약·`verification_files`·직접 실행할 `verification_command`를 담는다. Parent plan-set만 feature E2E `execution_profile`을 담는다. `bd dep add <beads-ticket-id> <depends-on-beads-id>`로 plan 의존성을 기록한다.

## Tracker 연결과 lifecycle

GitHub 발행 뒤 Beads 항목에 Issue URL 기반 `external_ref`와 `harness_tracker_version=1`, `harness_classification=committed`, `harness_phase=planning` metadata를 연결한다. 완료 state의 `tracker_sync.ticket_refs`에 parent와 모든 child `owner/repo#number`를 담아 lifecycle gate가 tracker와 Beads mirror를 대조하도록 한다. Dependency edge는 선택한 tracker와 Beads 양쪽에 기록하며 GitHub parent-child 관계는 [batch publish 절차](github-batch-publish.md)로 생성·검증한다.

`plan_finalize`는 선택한 configured tracker에 parent/child 티켓을 발행하고 Beads 항목과 연결한다. 이후 lifecycle 상태 동기화는 공용 Beads 스킬의 v1 mirror 절차를 사용한다.
