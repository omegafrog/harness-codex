---
name: implement-wrapper
description: Schedule approved plans into dependency-safe, single-slot subagent executions with handoff and conflict routing.
---

# implement-wrapper

Use `implement-wrapper` for approved multi-plan tickets. Wrapper schedules and routes; `implement` subagents implement, verify, review, commit, and update status. Model and reasoning selection belong to the caller/runtime; this skill does not force either.

## Schedule

- Read `docs/plans/<plan-set-id>/plans.md` when present for split-plan backlinks and summaries. Each plan set has its own directory; never read or write a shared `docs/plans/plans.md`. In GitHub mode, resolve approval, status, dependencies, and shared resources from the linked parent/child Issues and GitHub Project; in local-markdown mode, resolve them from the linked plan documents.
- Read `.codex/harness.yaml` first. A `Planned` GitHub Project item or `planned` local ticket with no incomplete blockers is a candidate; dependencies wait for completion in the selected tracker.
- Keep model and reasoning selection under caller/runtime policy. Do not infer or force a model tier for plan execution.
- Shared resource conflict or uncertainty means sequential execution; independent plans spawn in parallel.
- Give each plan one execution slot. A slot limits concurrent work; it does not reserve an agent identity or permit an agent to execute another plan. Return `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids`, and reasons.
- Start every plan ticket with a newly spawned `implement` subagent whose execution context contains no prior plan work. Never reuse a completed, handed-off, or blocked plan's subagent for the next plan.
- Before dispatch, assess whether the plan's next bounded implementation action fits inside the Context Smart Zone: enough remaining context to reload the plan/specs/checkpoint, implement or resolve one code blocker, and run its focused verification. If it does not fit, checkpoint and start a fresh subagent for the same plan.
- Prompt each subagent with repository, exact plan path, its `docs/plans/<plan-set-id>/plans.md` backlink, `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`, `.codex/skills/implement/SKILL.md`, checkpoint, dependency/resource facts, Smart Zone assessment, and exactly one plan/strict scope. Do not implement checkpoint, conflict, or reconciliation in this slice.
- Every dispatched `implement` subagent must run the review gate after implementation: capture the pre-change `HEAD` as the fixed point, commit the implementation, then invoke `code-review` with that fixed point and wait for both independent reviewers. `standards_reviewer` evaluates implementation against the Product Spec; `spec_reviewer` evaluates implementation against the Architecture Spec. A missing review result keeps the plan unresolved.

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
smart_zone: <dispatch | before-next-action | after-action; fits | handoff-required; evidence>
next_action: <text>
handoff_reason: context-threshold | plan-boundary | milestone | retry
updated_at: <timestamp>
```

Before a subagent starts, assess the Context Smart Zone. After every material action, assess the Context Smart Zone again, including after a test failure, code-blocker attempt, milestone, and completion. If the next action would cross the zone, write a checkpoint with `handoff_reason: context-threshold`, stop that agent, and start a new empty-context subagent for the same `in-progress` plan. A handoff resumes the same plan only through that new subagent; the single plan slot resumes as `in-progress`. Read checkpoint, plan, specs, and Git/test state. Actual state is the source of truth; correct the checkpoint.

At every plan boundary, checkpoint the completed plan and dispatch the next eligible plan only to a new empty-context subagent, even when the previous agent has remaining context. Record `handoff_reason: plan-boundary`; a plan boundary is never a reason to continue with the previous agent.

## Conflict / blocker

- Record conflict evidence and affected plan ids in each related plan's checkpoint; stops the related execution slots as `conflict-paused`.
- The wrapper does not automatically merge. Conflict-paused plans cannot resume before the main session makes an explicit priority decision; it selects exactly one affected plan to resume first and remaining plans are re-evaluated.
- Report blocker kind, summary, and exact unblock condition. The implementing subagent owns code blocker resolution inside the Context Smart Zone: diagnose, make the bounded fix, and run focused verification in the active plan slot. A code blocker that would exceed the zone is checkpointed and handed to a new empty-context subagent for the same plan; it is not made official `blocked` merely for a context limit. An external environment, authority, dependency, or decision blocker is official `blocked`.
- If blocker resolution requires a new architecture decision, cross-plan reconciliation, or complex root-cause analysis, escalate the fresh recovery subagent according to caller/runtime policy; ordinary retries remain in the normal execution lane.
- If the plan requires actual E2E or server execution, dispatch a fresh `execution_runner` subagent according to caller/runtime policy. It owns process startup, log collection, polling until completion or timeout, and result reporting; it does not edit implementation files.

Canonical ticket statuses are `Planned`, `In Progress`, `Blocked`, `Done` in GitHub Project mode and `planned`, `in-progress`, `blocked`, `completed` in local-markdown mode. Keep `conflict-paused` and `priority-routed` as orchestration states, never tracker status.

## Completion

Delegate completion to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status. The completion handoff must include both Standards and Spec reports separately. On completed plan status, re-evaluate selected-tracker dependents. After each split plan's implementation, verification, commit, and both reviews are fully complete and resolved, `implement` moves that plan to `Done` (`completed` in local-markdown mode). Only after every split plan in the set is terminal and verified, invoke or recommend `gh-open-pr` exactly once for one plan-set integration PR; never create or update a PR at an individual split-plan boundary. Do not merge automatically.

After a split plan completes, keep its child Issue open but set its configured `Workflow Status` Project field to `Done` with `gh project item-edit`; do not update the default Project `Status` field as a substitute. Verify the configured field is `Done` and the child Issue remains open before reporting completion. This status does not wait for the integration PR merge. Recalculate selected-tracker dependents from completed split plans. After the one plan-set integration PR merges, verify intended Issue closure only; do not roll completed split plans back to `In Progress`. An incomplete or unresolved ticket remains waiting. Do not copy status into a second tracker or use triage labels for execution state. Report at least one executable ticket or that the entire graph is blocked.

Do not auto-merge or auto-prioritize. `ui ~ entity` E2E cannot run: missing runtime is an environment blocker; unblock condition is a provisioned UI/entity runtime and backing service. Contract tests are the executable verification.
