# Plan finalization

`plan_finalize` stage는 최신 review 결과가 pass인 plan set을 tracker 발행 가능한 상태로 확정한다.

1. `node .codex/scripts/harness-plan-review.mjs check --root <workspace_root> --plan-set <plan-set-id> --phase planning`을 실행해 현재 canonical plan·Spec snapshot의 pass를 확인한다.
2. `.codex/harness.yaml`에서 configured tracker와 Beads 설정을 확인한다. Beads가 활성화된 경우에만 [Beads 티켓 미러 절차](beads.md)로 parent/child 항목과 dependency를 준비한다.
3. `local-markdown` mode는 승인된 plan set의 ticket 파일을 `planned` 상태로 발행한다. GitHub mode는 모든 canonical plan과 Issue draft를 다시 확인한 뒤 [GitHub batch publish](github-batch-publish.md)로 parent/child Issues, Project 등록, `Workflow Status: Planned`를 batch 처리한다. Tracker mutation은 현재 plan-review gate pass 뒤에 수행한다.
4. 성공한 publish 응답을 `<session_directory>/runtime/to-ticket/publish-state.json`에 저장하고 각 Issue의 ID·number·URL을 보존한다. `plans.md`는 review가 승인한 canonical index로 유지한다. Tracker 참조와 Beads `external_ref`를 completion state의 `tracker_sync.ticket_refs`에 기록해 완료 gate가 전체 set을 확인하도록 한다.
5. blocking edge를 configured tracker에 기록하고 published parent/child 관계를 검증한다. Beads가 활성화된 경우 mirror와 lifecycle metadata도 [공용 Beads 스킬](../../beads/SKILL.md)에 따라 동기화한다.
6. `<session_directory>/runtime/to-ticket/completion.json`에 `plan_set_id`, `completion_kind: plan_set_ready_for_implementation`, configured tracker refs, Beads refs, final review attempt ID를 기록한다. 이 파일을 `plan_set_ready_for_implementation` artifact로 반환한다. 기능 구현 완료와 통합 계약 갱신은 구현 통합 workflow가 기록한다.
