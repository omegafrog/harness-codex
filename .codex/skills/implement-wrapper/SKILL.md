---
name: implement-wrapper
description: Schedule approved implementation plans into dependency-safe, single-slot subagent executions.
---

# implement-wrapper

`implement-wrapper`는 `implement`를 plan별 subagent 실행으로 감싼다. wrapper는 선택·스케줄·handoff·충돌 라우팅을 담당하고, subagent는 구현 lifecycle을 담당한다.

## Schedule

- `docs/plans/plans.md`는 backlink index다. 각 plan 문서에서 status, approval, dependencies, shared resources를 읽는다.
- `ready-for-agent`이고 모든 dependency가 `completed`인 plan만 candidate다. blocker나 미완료 dependency가 있으면 기다린다.
- shared resource가 겹치거나 안전성이 불확실하면 순차 실행한다. 독립 plan은 병렬 spawn할 수 있다.
- independent plans may spawn in parallel. Each plan has one execution slot; the same plan gets one subagent only.
- 선택 결과는 `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids`와 대기 사유를 포함한다.

## Delegate

모든 subagent prompt에 다음을 포함한다.

- repository working directory와 정확한 plan path
- `docs/plans/plans.md` backlink
- `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`
- `.codex/skills/implement/SKILL.md`
- dependency/shared-resource facts와 “exactly one plan, strict scope” 지시. Do not implement checkpoint, conflict, or reconciliation in this slice.

subagent는 `implement`에 따라 test-first, 최소 구현, verification, commit, status/reconciliation, code review를 수행한다. wrapper는 이를 중복하지 않고 결과를 기다린다.

## Checkpoint

경로는 `docs/plans/.runtime/<plan-id>/checkpoint.md`이며 checkpoint is gitignored and does not replace the official plan status. 새 prompt에는 항상 이 경로를 포함한다.

```yaml
plan_id: <plan-id>
orchestration_state: running | handoff-required | conflict-paused | priority-routed
attempt: <integer>
last_completed_step: <text>
changed_files: []
tests:
  - command: <command>
    result: passed | failed | not-run
    evidence: <text>
blocker:
  kind: none | code | environment | decision | conflict
  summary: <text>
  unblock_condition: <text>
next_action: <text>
handoff_reason: context-threshold | milestone | retry
updated_at: <timestamp>
```

context safety threshold 또는 milestone에서 handoff한다. Handoff of the same plan resumes it as `in-progress`; one single slot resumes the subagent. 새 subagent는 checkpoint, plan, specs, 실제 Git/test 상태를 읽는다. Actual state is the source of truth; correct the checkpoint when it disagrees.

## Conflict and blockers

- overlapping changes나 Git conflict가 발생하면 conflict evidence와 affected plan ids in each related plan's checkpoint를 기록하고 stops the related execution slots in `conflict-paused`.
- The wrapper does not automatically merge, discard, or rewrite. Conflict-paused plans cannot resume before the main session makes an explicit priority decision.
- main session은 `priority-routed`로 기록하고 selects exactly one affected plan to resume first. remaining plans are re-evaluated against actual Git/test state.
- blocker report에는 kind, summary, exact unblock condition을 포함한다. The implementing subagent owns code blocker resolution. An external environment, authority, dependency, or decision blocker is official `blocked`.
- external environment, authority, dependency, decision만 official `blocked`다. This is an environment blocker; the unblock condition must be explicit.

공식 plan status는 `planned`, `ready-for-agent`, `in-progress`, `completed`, `blocked`만 사용한다. `conflict-paused`와 `priority-routed`는 orchestration state다.

## Completion

`implement`의 결과만 completion authority다. Completion delegates to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status.

After a completed plan, `implement` recalculates dependent plans. A completed plan recalculates dependent plans; incomplete or unresolved plans remain `planned` or waiting. A `planned` plan becomes `ready-for-agent` only when all dependencies are `completed` and no blocker remains. The label and Issue status are aligned exactly; removing it from `planned`, `in-progress`, `completed`, and `blocked`. Report at least one executable `ready-for-agent` plan, or that the entire graph is blocked.

자동 priority와 자동 merge는 범위 밖이다. `ui ~ entity` E2E는 이 저장소에 UI/entity runtime이 없어 cannot run이며, provisioned runtime과 backing service가 environment unblock condition이다. contract tests가 이 slice의 실행 가능한 검증이다.
