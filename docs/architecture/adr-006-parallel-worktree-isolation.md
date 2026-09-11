# ADR-006: Parallel Group Worktree 격리

- 상태: Accepted
- 결정일: 2026-09-10

## Context

현재 wrapper에는 독립 plan 병렬 실행 규칙은 있지만 실제 workspace 격리 경계가 없다. 모든 split plan에 worktree를 만들면 순차 dependency chain과 Smart Zone 실행 단위를 혼동하게 되고, 같은 group의 sibling이 서로 다른 기준에서 시작할 수 있다.

## Decision

Scheduler가 dependency graph와 resource graph를 계산한다. 다음 조건을 모두 만족하는 runnable plan이 2개 이상일 때만 parallel group을 만든다.

```yaml
parallelization:
  condition:
    - runnable_plans >= 2
    - dependencies_satisfied
    - no_shared_write_resource
```

같은 parallel group의 각 plan은 동일한 `Fixed Group Base` commit에서 시작하는 isolated worktree를 사용한다. 한 plan의 완료 commit을 다른 sibling의 base로 사용하지 않는다.

Dependency chain은 같은 `Execution Line`과 workspace에서 순차 실행한다. 단일 runnable plan은 worktree를 만들지 않는다. Split plan은 Smart Zone 실행 단위이며 병렬성을 암시하지 않는다.

Resource graph는 filesystem path뿐 아니라 logical module, DB/schema, public contract, generated artifact, shared configuration을 포함한다. shared write resource가 있거나 독립성이 불확실하면 parallel 대신 serialize한다.

Runnable plan이 모두 pairwise-independent일 필요는 없다. Scheduler는 deterministic한 independent batch를 추출해 각 batch를 scheduling wave로 실행한다. 같은 wave에서 충돌하는 plan은 sequential remainder로 남기며, 한 batch의 `group_id`는 `run_id`, `scheduling_wave`, batch index와 plan IDs로 구성한다. `fixed_group_base`는 group identity가 아니라 모든 sibling worktree가 공유하는 시작 commit 속성이다.

Parallel 실행 완료 후 자동 merge하지 않는다. commits와 evidence를 수집한 뒤 별도 integration decision, conflict/test/review 단계를 거친다. Worktree는 execution 종료 후 cleanup하며 journal/evidence는 worktree 밖 runtime 경계에 보존한다.

`WorktreeManager`는 base SHA, final HEAD SHA, dirty state를 발견·보고할 수 있지만 commit 생성·branch 전략·merge/integration 판단은 담당하지 않는다. Dirty worktree는 evidence를 먼저 보존하고 cleanup policy에 따라 leak 또는 blocked로 보고한다. 암묵적인 `git worktree remove --force`는 금지한다.

실행 결과와 cleanup 결과는 분리해 기록한다.

```yaml
execution_result:
  state: passed | failed
cleanup:
  state: passed | failed
  reason: worktree_leak | workspace_cleanup_failure | null
case:
  state: passed | failed | inconclusive
```

Execution이 성공·실패했더라도 cleanup이 실패하면 최종 case는 `inconclusive`로 승격한다. 기존 execution result와 evidence는 보존한다. Leak가 해소될 때까지 동일 execution environment의 신규 dispatch와 해당 workspace pool 재사용을 차단하지만, 이미 독립적으로 실행 중인 다른 case는 종료하지 않는다.

## Consequences

- dependency chain의 연속성과 sibling 병렬성의 독립성을 동시에 보존한다.
- resource ownership 선언이 plan scheduling의 선행 조건이 된다.
- parallel 결과의 integration 비용은 남지만 자동 merge로 인한 silent conflict를 피한다.
- worktree allocation/lifecycle adapter와 resource graph 표현이 새 구현 seam이 된다.
