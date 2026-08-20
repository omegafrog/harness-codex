---
name: implement-wrapper
description: Schedule approved plans into dependency-safe, single-slot subagent executions.
---

# implement-wrapper

wrapper = schedule, delegate, handoff, route; `implement` subagent = implement, verify, review, commit, status.

## Schedule / delegate

- Read `docs/plans/plans.md` backlinks; use each plan's approval, status, dependencies, shared resources.
- Dependency-free `ready-for-agent` plans are candidates; dependencies wait for `completed`. Uncertain/shared resources => sequential; independent plans spawn in parallel.
- Each plan has one execution slot; the same plan gets one subagent only. Return `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids` and reasons.
- Prompt: repository, exact plan path, `docs/plans/plans.md` backlink, `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`, `.codex/skills/implement/SKILL.md`, dependencies/resources, exactly one plan and strict scope. Do not implement checkpoint, conflict, or reconciliation in this slice.

## Checkpoint / handoff

`docs/plans/.runtime/<plan-id>/checkpoint.md` is gitignored and does not replace the official plan status; include it in every prompt.

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

At context threshold/milestone, handoff resumes the same plan as `in-progress`; one single slot resumes the subagent. Read checkpoint, plan, specs, Git/test state. Actual state is source of truth; correct the checkpoint.

## Conflict / blocker

- Record conflict evidence + affected plan ids in each related plan's checkpoint; stops the related execution slots as `conflict-paused`.
- The wrapper does not automatically merge. Conflict-paused plans cannot resume before the main session makes an explicit priority decision; it selects exactly one affected plan to resume first and remaining plans are re-evaluated.
- Blocker report = kind, summary, exact unblock condition. The implementing subagent owns code blocker resolution. An external environment, authority, dependency, or decision blocker is official `blocked`.
- Official plan status only: `planned`, `ready-for-agent`, `in-progress`, `completed`, `blocked`; orchestration-only: `conflict-paused`, `priority-routed`.

## Completion / reconciliation

Completion delegates to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status.

After a completed plan, `implement` recalculates dependent plans. A completed plan recalculates dependent plans; incomplete or unresolved plans remain `planned` or waiting. A `planned` plan becomes `ready-for-agent` only when all dependencies are `completed` and no blocker remains. The `ready-for-agent` label and Issue status are aligned exactly; removing it from `planned`, `in-progress`, `completed`, `blocked`. Report at least one executable `ready-for-agent` plan or that the entire graph is blocked.

No automatic merge/priority. `ui ~ entity` E2E cannot run: missing runtime is an environment blocker; unblock condition = provisioned UI/entity runtime and backing service. Contract tests are the executable verification.
