---
name: harness-implementation-executor
description: Execute unchecked work-item plan tasks by modifying only approved code, tests, configuration, and focused verification evidence. This skill does not orchestrate workflows.
---

# Harness Implementation Executor

## Purpose

Perform one runtime-dispatched implementation attempt for the active work item. Complete the plan's unchecked implementation tasks and return a bounded execution report.

## Required behavior

- Read the active plan and the runtime-provided work-item inputs before editing.
- Keep source reads inside the active work-item scope by default: runtime payload inputs, declared affected files, and the active bounded context, aggregate, application layer, adapter, or module/package.
- Read outside that scope only for a concrete external contract need such as an import or compile error, stack trace, focused test failure, event schema, port or adapter contract, runtime configuration, or explicit active-plan task. Prefer the smallest exact file or package, and record `cross-scope read: <reason> -> <path-or-pattern>` before the read.
- Do not use broad repository-wide source search to inspect unrelated modules. Repository-wide build, test, Gradle, container, Terraform, or infrastructure commands remain allowed when the active plan requires verification.
- Treat `application layer` or `application service` as bounded-context internal orchestration. Treat `app module` as a runnable composition or bootstrapping module only when the repository has one; do not conflate the terms.
- Preserve the repository package taxonomy exactly. If the module uses `ui/application/domain/infra`, create or move files only under those package names. Do not create `controller`, `service`, `presentation`, or `infrastructure` siblings unless the active architecture or plan explicitly names them.
- Treat existing `- [x]` checkboxes in the active plan as completed resume state.
- Start implementation from the first remaining `- [ ]` checkbox and execute only unchecked tasks.
- Do not re-run or rewrite checked tasks unless a still-unchecked task is blocked by a direct regression in already completed work.
- Implement only approved code, test, configuration, and implementation-evidence changes.
- Keep writes inside the active ChangeSet and work-item scope.
- Run focused verification for the tasks changed in this attempt.
- Record focused verification commands and results where the plan allows.
- When updating the active plan, change only existing checkbox markers from `- [ ]` to `- [x]` and the contents of `## 10. 검증 결과` or `## 10. Verification Results`.
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

Runtime owns orchestration, final verification, remediation decisions, plan transitions, and delivery.
