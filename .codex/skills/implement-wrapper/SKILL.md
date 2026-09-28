---
name: implement-wrapper
description: Schedule approved plans into dependency-safe, single-slot subagent executions with handoff and conflict routing.
---

# implement-wrapper

Use `implement-wrapper` for approved multi-plan tickets. Wrapper schedules and routes; `implement` subagents implement, verify, review, commit, and update status. Model and reasoning selection belong to the caller/runtime; this skill does not force either.

## Schedule

## 작업 루트 전달과 검증

- 활성 세션 worktree를 절대 `execution_line`으로 확정한다. 모든 실행 슬롯은 모드와 관계없이 절대 `workspace_root`와 `cwd`를 받는다. 병렬 계획은 계획별 격리 worktree를 받고, 순차 계획은 `execution_line`을 재사용한다.
- 구현 에이전트와 E2E runner는 파일 접근이나 서비스 시작 전에 `pwd`와 `git rev-parse --show-toplevel`을 전달받은 루트와 대조한다. 구현 결과에 확인한 루트를 포함하고 wrapper가 일치 여부를 검사한다.

- Read `docs/plans/<plan-set-id>/plans.md` when present for split-plan backlinks and summaries. Each plan set has its own directory; never read or write a shared `docs/plans/plans.md`. In GitHub mode, resolve approval, status, dependencies, and shared resources from the linked parent/child Issues and GitHub Project; in local-markdown mode, resolve them from the linked plan documents.
- Read `.codex/harness.yaml` first. A `Planned` GitHub Project item or `planned` local ticket with no incomplete blockers is a candidate; dependencies wait for completion in the selected tracker.
- Keep model and reasoning selection under caller/runtime policy. Do not infer or force a model tier for plan execution.
- Shared resource conflict or uncertainty means sequential execution; independent plans spawn in parallel.
- Resolve one absolute `execution_line` root for the plan set from the active session worktree. Every plan dispatch must pass an explicit absolute `workspace_root` and `cwd`: parallel plans receive their allocated isolated worktree, while sequential plans receive the same `execution_line` root. Sequential mode does not allocate a new per-plan worktree, but it still receives and verifies its working root.
- Give each plan one execution slot. A slot limits concurrent work; it does not reserve an agent identity or permit an agent to execute another plan. Return `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids`, and reasons.
- Start every plan ticket with a newly spawned `implement` subagent whose execution context contains no prior plan work. Never reuse a completed, handed-off, or blocked plan's subagent for the next plan.
- Before dispatch, assess whether the plan's next bounded implementation action fits inside the Context Smart Zone: enough remaining context to reload the plan/specs/checkpoint, implement or resolve one code blocker, and run its focused verification. If it does not fit, checkpoint and start a fresh subagent for the same plan.
- Prompt each subagent with repository, absolute `workspace_root`, exact plan path, its `docs/plans/<plan-set-id>/plans.md` backlink, `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`, `.codex/skills/implement/SKILL.md`, checkpoint, dependency/resource facts, Smart Zone assessment, and exactly one plan/strict scope. The spawn adapter must set `cwd` to `workspace_root`. Require the implementer to report the verified `git rev-parse --show-toplevel`; reject a mismatch before review or completion. Do not implement checkpoint, conflict, or reconciliation in this slice.
- Every dispatched `implement` subagent must run the review gate after implementation: capture the pre-change `HEAD` as the fixed point, commit the implementation, then invoke `code-review` with that fixed point and wait for both independent reviewers. `standards_reviewer` evaluates implementation against the Product Spec; `spec_reviewer` evaluates implementation against the Architecture Spec. A missing review result keeps the plan unresolved.
- Parallel worktrees use a dedicated `harness/<run>/<group>/<plan>-<instance>` branch created at the group's fixed base. The implementer must commit there. Removing the temporary worktree preserves that branch; record its name and final implementation commit in the plan checkpoint so cleanup cannot orphan the result.

## Handoff

Use `docs/plans/.runtime/<plan-id>/checkpoint.md`; it is local-only, gitignored, and does not replace the official plan status. Never upload, publish, or copy `checkpoint.md` or `events.jsonl` to GitHub Issues, comments, Project fields, PR bodies, commits, or pushes. Include the local path in every prompt.

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
- Parallel branches are not merged while their workers are running. Conflict-paused plans cannot resume before the main session makes an explicit priority decision; it selects exactly one affected plan to resume first and remaining plans are re-evaluated.
- Report blocker kind, summary, and exact unblock condition. The implementing subagent owns code blocker resolution inside the Context Smart Zone: diagnose, make the bounded fix, and run focused verification in the active plan slot. A code blocker that would exceed the zone is checkpointed and handed to a new empty-context subagent for the same plan; it is not made official `blocked` merely for a context limit. An external environment, authority, dependency, or decision blocker is official `blocked`.
- If blocker resolution requires a new architecture decision, cross-plan reconciliation, or complex root-cause analysis, escalate the fresh recovery subagent according to caller/runtime policy; ordinary retries remain in the normal execution lane.
- If the plan requires actual full-stack E2E or server execution, dispatch the configured E2E runner with the same absolute `workspace_root` and `cwd` as the implementer. It owns process startup, log collection, polling until completion or timeout, and result reporting; it does not edit implementation files. Require its startup root check to match before it launches services.

Canonical ticket statuses are `Planned`, `In Progress`, `Blocked`, `Done` in GitHub Project mode and `planned`, `in-progress`, `blocked`, `completed` in local-markdown mode. Keep `conflict-paused` and `priority-routed` as orchestration states, never tracker status.

## Completion

Delegate completion to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status. The completion handoff must include both Standards and Spec reports separately. On completed plan status, re-evaluate selected-tracker dependents. After each split plan's implementation, verification, commit, and both reviews are fully complete and resolved, `implement` moves that plan to `Done` (`completed` in local-markdown mode). After every split plan is terminal and verified, integrate each preserved parallel plan branch into the explicit `execution_line` plan-set branch, one at a time, with `WorktreeManager.integrate`; pass the expected session branch and keep the integration order in the checkpoint. The integration helper checks the target branch, clean state, and shared fixed base, and aborts a conflicted merge while retaining all plan branches. Resolve any conflict in the plan-set branch and re-run the integration gate before proceeding. Only after integration succeeds, invoke or recommend `gh-open-pr` exactly once for that plan-set branch; never create or update a PR at an individual split-plan boundary. Do not merge the PR automatically.

After a split plan completes, keep its child Issue open but set its configured `Workflow Status` Project field to `Done` with `gh project item-edit`; do not update the default Project `Status` field as a substitute. Verify the configured field is `Done` and the child Issue remains open before reporting completion. This status does not wait for the integration PR merge. Recalculate selected-tracker dependents from completed split plans. After the one plan-set integration PR merges, verify intended Issue closure only; do not roll completed split plans back to `In Progress`. An incomplete or unresolved ticket remains waiting. Do not copy status into a second tracker or use triage labels for execution state. Report at least one executable ticket or that the entire graph is blocked.

Do not auto-merge or auto-prioritize. `ui ~ entity` E2E cannot run: missing runtime is an environment blocker; unblock condition is a provisioned UI/entity runtime and backing service. Contract tests are the executable verification.
