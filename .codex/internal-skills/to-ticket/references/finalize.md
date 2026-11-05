# Plan finalization

`to-ticket`은 자체 독립 reviewer loop 안에서 계획 작성을 마무리한다. runner는 canonical review 기록과 현재 계획 snapshot을 확인하며, tracker 발행은 후속 `tracker-publish` stage의 책임이다.

작업 전에 `context.worktree_ref`의 정본 `worktree.json`을 읽어 작업 worktree, session과 `plan_set_id`를 확인한다. 기록이 없거나 ID가 없으면 중단한다. 해당 worktree의 `docs/plans/<plan-set-id>/`를 사용한다.

1. `node .codex/scripts/harness-plan-review.mjs check --root <workspace_root> --plan-set <plan-set-id> --phase planning`을 실행해 현재 canonical plan·Spec snapshot의 pass를 확인한다.
2. `.codex/harness.yaml`의 tracker mode를 확인한다. `local-markdown`이면 `docs/plans/<plan-set-id>/plans.md`와 각 split plan을 `planned` 상태의 정본 ticket으로 보존한다. GitHub mode에서는 Issue·Project mutation을 하지 않는다.
3. 현재 review snapshot과 canonical plan index가 승인된 결과와 일치하는지 확인한다.
4. 계획과 최종 review 기록을 보존하고 `to-ticket` stage를 완료한다. 다음 workflow stage인 `tracker-publish`가 tracker/Beads를 발행하고 발행 journal과 stage result를 남긴다.
