---
name: harness-implementation-executor
description: Execute unchecked work-item plan tasks by modifying only approved code, tests, configuration, and focused verification evidence. This skill does not orchestrate workflows.
---

# Harness Implementation Executor

## Purpose

Perform one runtime-dispatched implementation attempt for the active work item. Complete the plan's unchecked implementation tasks and return a bounded execution report.

## Fixed control plane

Before task work, load `.codex/skills/harness-implementation-executor/references/ddd-implementation-policy.md`.

The policy is a stable implementation constraint for DDD layer roles, dependency direction, aggregates, ports/adapters, transaction/event handling, DTO mapping, and architecture tests. It does not supply task-specific product behavior. The active `plan.md` remains the sole task-specific instruction.

## Required behavior

- Read the fixed DDD implementation policy, active plan, and runtime-provided execution-scope artifact before editing.
- Treat the active `plan.md` as the sole product and task-specific implementation instruction. Do not read use-case, event-storming, E2E-goal, ChangeSet, architecture, or technical-decision artifacts to reinterpret the plan.
- Require the plan to state execution scope, package/dependency contract, domain implementation contract, external-contract read allowlist, task checklist, and focused verification. Report a blocker when a required decision is missing, contradictory, or a placeholder.
- Keep source reads inside the active work-item scope by default: the active plan, execution-scope artifact, declared affected files, and the active bounded context, aggregate, application layer, adapter, or module/package named by the plan.
- Read outside that scope only for a concrete external contract need such as an import or compile error, stack trace, focused test failure, event schema, port or adapter contract, runtime configuration, or explicit active-plan task. Prefer the smallest exact file or package, and record `cross-scope read: <reason> -> <path-or-pattern>` before the read.
- Do not use broad repository-wide source search to inspect unrelated modules. Repository-wide build, test, Gradle, container, Terraform, or infrastructure commands remain allowed when the active plan requires verification.
- Preserve the repository package taxonomy exactly. If the plan uses `ui/application/domain/infra`, create or move files only under those package names. Do not create `controller`, `service`, `presentation`, or `infrastructure` siblings unless the active plan explicitly names them.
- Treat existing `- [x]` checkboxes in the active plan as completed resume state.
- Start implementation from the first remaining `- [ ]` checkbox and execute only unchecked tasks.
- Do not re-run or rewrite checked tasks unless a still-unchecked task is blocked by a direct regression in already completed work.
- Implement only approved code, test, configuration, and implementation-evidence changes.
- Keep writes inside the active ChangeSet and work-item scope declared by the runtime-owned execution-scope artifact.
- Run focused verification for the tasks changed in this attempt.
- Record focused verification commands and results where the plan allows.
- When updating the active plan, change only existing checkbox markers from `- [ ]` to `- [x]` and the contents of the existing `검증 결과` or `Verification Results` section.
- Check off each completed task immediately after finishing that task and before starting the next one, so runtime dashboard polling can show progress during long implementation runs or interrupted sessions.
- Do not rewrite plan goals, non-goals, input documents, architecture constraints, scope boundaries, task wording, completion policy, or any completed-plan path.
- Report changed files, completed tasks, remaining tasks, focused verification results, and blockers.
- Preserve unrelated worktree changes.

## Explicit non-responsibilities

- Do not invoke another agent, nested Codex process, or workflow.
- Do not select work items, replan, append remediation, or decide whether to resume execution.
- Do not perform or classify final verification.
- Do not move active plans to completed plans.
- Do not create wiki artifacts, commits, branches, or pull requests.
- Do not inspect upstream design artifacts to fill missing plan detail; stop and report the plan blocker instead.

Runtime owns orchestration, final verification, remediation decisions, plan transitions, delivery, and enforcement of ChangeSet/affected-files write authority.
