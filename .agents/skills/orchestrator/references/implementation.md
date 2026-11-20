# 구현 workflow 조율

새 기능의 구현은 `tactical-to-code` workflow만 사용한다. 완료된 전술 설계 뒤 `tactical-technology` → `tactical-ui` → `tactical-api` → `tactical-data` → `to-ticket` → `tracker-publish` → `tactical-code` 순으로 진행한다. legacy Spec/Plan 기반 구현 경로는 없다.

구현할 때 `harness-context.mjs`가 제공하는 `ready_tickets`에서 다음 ticket을 하나 고르고 `harness-native-stage.mjs launch --stage-id tactical-code --plan <ticket-id>`로 실행한다. 한 실행은 ticket 하나만 구현한다. 미완료 선행 ticket, 이미 완료된 ticket, stale 계획 리뷰가 있는 ticket은 실행기가 거부한다. 각 ticket 실행은 ticket에 명시된 업무 규칙 테스트와 필요한 검증을 수행하고, 성공 시 로컬 canonical ticket 상태와 변경 파일의 정확한 `commit_request`를 남긴다. 구현 stage가 직접 `git commit`하지 않는다. 다음 ticket은 이전 실행의 commit 및 상태가 정본에 기록된 뒤 새 실행으로 배정한다. tracker 상태의 정본은 local ticket이며 GitHub Issue/Project는 보조 mirror다.

구현 도중 문서에 확정되지 않은 요구사항·전술 설계·계획 결정이 드러나면 구현 stage가 임의로 정하거나 사용자에게 직접 묻지 않는다. `DEPENDENCY_INCOMPLETE`와 `owner_stage`, `dependency_gap`으로 가장 앞선 소유 stage에 되돌린다. 사용자의 직접 구현 수정 지시는 `--user-revision true --feedback '<사용자 지시 원문>'`으로 해당 ticket 실행에 전달한다.

`frontend: true` ticket은 독립 `frontend-implementation`과 `frontend-visual-review`를 마친 뒤 `tactical-code`로 완료한다. 실제 사용자 흐름 E2E는 명시적으로 요청된 경우 별도 `e2e-test` stage가 소유하며, 구현 stage에서 자동 실행하지 않는다. 최종 요청 범위가 끝나면 `harness-workflow-complete.mjs`의 `tactical-to-code` 완료 gate를 통과시킨다.

## E2E 실행 승인과 실패 처리

사용자가 별도로 요청한 실제 사용자 흐름 검증은 시나리오·기대 결과·실행 조건·대상 commit을 제시하고 실행 승인을 받는다. 승인 뒤 session의 `runtime/e2e/requests/<id>.json`에 `target_commit`, `profile_id`, `scenarios`(시나리오 ID 배열), `timeout_ms`, `.harness/agents/execution.json`의 `manifest_sha256`와 실제 사용자 `approval_answer`를 기록한다. 해당 파일을 `harness-native-stage.mjs launch --stage-id e2e-test --e2e-request <session-relative-request>`에 넘긴다. 반환된 fresh `e2e_test_runner`를 시작하고 실제 결과를 기다린 뒤 `next.finish`로 검증한다. 실패하면 증거와 소유 자원 정리 결과를 보존한다. 수정과 재실행에는 각각 사용자 승인을 받는다.
