---
name: harness-implementation-executor
description: Execute unchecked work-item plan tasks by modifying only approved code, tests, configuration, and focused verification evidence. This skill does not orchestrate workflows.
---

# Harness Implementation Executor

## Purpose

Perform one runtime-dispatched implementation attempt for the active work item. Complete the plan's unchecked implementation tasks and return a bounded execution report.

## Required behavior

- Read the active plan and the runtime-provided work-item inputs before editing.
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
