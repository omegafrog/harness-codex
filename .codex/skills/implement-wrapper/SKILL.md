---
name: implement-wrapper
description: Schedule approved implementation plans into dependency-safe, single-slot subagent executions.
---

# implement-wrapper

`implement-wrapper` is the scheduler boundary around the public `implement` skill. It owns plan selection and execution-slot scheduling; the delegated implementation agent owns the implementation lifecycle.

## Scheduler contract

The wrapper reads `docs/plans/plans.md` as an index and follows each backlink to its individual plan document. It reads the plan's status, approval, dependencies, and declared shared resources. It does not treat the index as a plan body.

A dependency-free plan is an executable candidate only when it is approved, has status `ready-for-agent`, and has no unresolved blocker. A dependency plan remains waiting until its dependency status is `completed`. Plans with uncertain or overlapping shared resources are scheduled sequentially; the wrapper must not guess that a resource is safe to share.

Independent candidates may be spawned in parallel. Each plan has one execution slot: while a plan slot is active, the wrapper must not spawn a second subagent for that same plan. A completed or stopped slot must be observed before that plan can receive another subagent.

The scheduler's selection result is conceptual data with these fields:

```yaml
ready_plans: []
waiting_plans: []
parallel_groups: []
single_slot_plan_ids: []
```

The result must explain why a plan is waiting and which shared resource caused sequential scheduling. It must preserve the declared plan order when parallel safety is uncertain.

## Delegation prompt contract

Every spawned subagent receives:

- the repository working directory;
- the exact plan path and its `docs/plans/plans.md` backlink;
- `docs/specs/product-spec.md`;
- `docs/specs/architecture-spec.md`;
- `.codex/skills/implement/SKILL.md`;
- an explicit instruction to execute exactly one plan and keep its scope strict;
- the plan's dependency and shared-resource facts.

The prompt must tell the subagent to use the `implement` skill, which performs tests first, minimum implementation, plan-specific verification, commit, plan status update, dependent-plan reconciliation, and code review. The wrapper does not duplicate those responsibilities.

The wrapper waits for the subagent result before releasing its execution slot. It reports the result to the main session and does not start a different plan as a substitute for a plan that is still waiting or active.

## Checkpoint and handoff contract

Each plan has one fixed, gitignored checkpoint path: `docs/plans/.runtime/<plan-id>/checkpoint.md`. The wrapper includes this path in every new and resumed subagent prompt. The checkpoint is ignored by Git and is resumable orchestration memory. The checkpoint does not replace the official plan status in the plan document.

The checkpoint uses this schema:

```yaml
plan_id: <plan-id>
orchestration_state: running | handoff-required
attempt: <integer>
last_completed_step: <text>
changed_files: []
tests:
  - command: <command>
    result: passed | failed | not-run
    evidence: <short evidence>
blocker:
  kind: none | code | environment | decision
  summary: <text>
  unblock_condition: <text>
next_action: <text>
handoff_reason: context-threshold | milestone | retry
updated_at: <timestamp>
```

The subagent writes a checkpoint when context reaches the safety threshold or a milestone completes. The handoff reason, completed step, changed files, test evidence, blocker, and next action must be recorded before the slot stops. A context handoff resumes the same plan in the same single slot: the wrapper starts a new subagent with `resume` and the plan remains officially `in-progress`.

The resumed prompt requires the new subagent to read the checkpoint, plan, specs, and current repository state before acting. If checkpoint data disagrees with actual Git or test state, the actual state is the source of truth; the new subagent records the correction in the checkpoint and continues from that evidence. The wrapper must not infer completion from a checkpoint alone.

## Scope boundary

This checkpoint slice does not implement conflict priority routing or reconciliation behavior. The wrapper must not implement conflict or reconciliation behavior here. Those are separate plans and must remain separate execution stages.

The `ui ~ entity` E2E contract is recorded but cannot run in this repository: no UI/entity runtime or end-to-end application exists here. If a future runner requests it, the environment blocker is the absence of that runtime and its backing entity service; the required unblock condition is a provisioned UI/entity runtime and test environment. Contract tests remain the executable verification for this slice.

## Completion boundary

The wrapper may report a scheduling decision and subagent outcome, but it must not edit implementation code or invent a new official plan status. A scheduler decision is not a plan completion decision; completion remains governed by the delegated `implement` lifecycle.
