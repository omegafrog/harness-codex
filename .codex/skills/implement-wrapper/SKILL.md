---
name: implement-wrapper
description: Schedule approved plans into dependency-safe, single-slot subagent executions with handoff and conflict routing.
---

# implement-wrapper

Use `implement-wrapper` for approved multi-plan tickets. Wrapper schedules and routes; `implement` subagents implement, verify, review, commit, and update status.

## Schedule

- Read `docs/plans/plans.md` backlinks and each plan's approval, status, dependencies, and shared resources.
- A dependency-free `ready-for-agent` plan is a candidate; dependencies wait for `completed`.
- Shared resource conflict or uncertainty means sequential execution; independent plans spawn in parallel.
- Give each plan one execution slot and one subagent. Return `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids`, and reasons.
- Prompt each subagent with repository, exact plan path, `docs/plans/plans.md` backlink, `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`, `.codex/skills/implement/SKILL.md`, dependency/resource facts, and exactly one plan/strict scope. Do not implement checkpoint, conflict, or reconciliation in this slice.

## Handoff

Use `docs/plans/.runtime/<plan-id>/checkpoint.md`; it is gitignored and does not replace the official plan status. Include it in every prompt.

```yaml
plan_id: <plan-id>
orchestration_state: running | handoff-required | conflict-paused | priority-routed
attempt: <integer>
last_completed_step: <text>
changed_files: []
tests: <evidence>
blocker: <kind, summary, unblock_condition>
next_action: <text>
handoff_reason: context-threshold | milestone | retry
updated_at: <timestamp>
```

At a context threshold or milestone, handoff resumes the same plan as `in-progress`; one single slot resumes the subagent. Read checkpoint, plan, specs, and Git/test state. Actual state is the source of truth; correct the checkpoint.

## Conflict / blocker

- Record conflict evidence and affected plan ids in each related plan's checkpoint; stops the related execution slots as `conflict-paused`.
- The wrapper does not automatically merge. Conflict-paused plans cannot resume before the main session makes an explicit priority decision; it selects exactly one affected plan to resume first and remaining plans are re-evaluated.
- Report blocker kind, summary, and exact unblock condition. The implementing subagent owns code blocker resolution. An external environment, authority, dependency, or decision blocker is official `blocked`.

Canonical statuses: `planned`, `ready-for-agent`, `in-progress`, `completed`, `blocked`. Keep `conflict-paused` and `priority-routed` as orchestration states, never official status.

## Completion

Delegate completion to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status.

After completion, `implement` recalculates dependent plans. A completed plan recalculates dependent plans; incomplete or unresolved plans remain `planned` or waiting. A `planned` plan becomes `ready-for-agent` only when all dependencies are `completed` and no blocker remains. Keep the `ready-for-agent` label and Issue status aligned exactly; removing it from `planned`, `in-progress`, `completed`, and `blocked`. Report at least one executable `ready-for-agent` plan or that the entire graph is blocked.

Do not auto-merge or auto-prioritize. `ui ~ entity` E2E cannot run: missing runtime is an environment blocker; unblock condition is a provisioned UI/entity runtime and backing service. Contract tests are the executable verification.
