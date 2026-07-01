---
name: harness-implementation-executor
description: Execute unchecked work-item plan tasks by modifying only approved code, tests, configuration, and focused verification evidence. This skill does not orchestrate workflows.
---

# Harness Implementation Executor

## Purpose

Perform one runtime-dispatched implementation attempt for the active work item. Complete the plan's unchecked implementation tasks and return a bounded execution report.

## Fixed control plane

Before task work, load `.codex/skills/harness-implementation-executor/references/ddd-implementation-policy.md` and `.codex/skills/caveman/SKILL.md`.

The policy is a stable implementation constraint for DDD layer roles, dependency direction, aggregates, ports/adapters, transaction/event handling, DTO mapping, and architecture tests. It does not supply task-specific product behavior. The active `plan.md` remains the sole task-specific instruction.

## Required behavior

- Read the fixed DDD implementation policy, active plan, and runtime-provided execution-scope artifact before editing.
- Apply `caveman` to all progress, final report, blocker, and verification output: terse Korean, no filler, technical substance intact.
- Treat the active `plan.md` as the sole product and task-specific implementation instruction. Do not read use-case, event-storming, E2E-goal, ChangeSet, architecture, or technical-decision artifacts to reinterpret the plan.
- Require the plan to state execution scope, package/dependency contract, domain implementation contract, external-contract read allowlist, task checklist, and focused verification. Report a blocker when a required decision is missing, contradictory, or a placeholder.
- Keep source reads inside the active work-item scope by default: the active plan, execution-scope artifact, and the active bounded context, aggregate, application layer, adapter, or module/package named by the plan.
- Read outside that scope only for a concrete external contract need such as an import or compile error, stack trace, focused test failure, event schema, port or adapter contract, runtime configuration, or explicit active-plan task. Prefer the smallest exact file or package, and record `cross-scope read: <reason> -> <path-or-pattern>` before the read.
- Do not use broad repository-wide source search to inspect unrelated modules. Repository-wide build, test, Gradle, container, Terraform, or infrastructure commands remain allowed when the active plan requires verification.
- Preserve the repository package taxonomy exactly. If the plan uses `ui/application/domain/infra`, create or move files only under those package names. Do not create `controller`, `service`, `presentation`, or `infrastructure` siblings unless the active plan explicitly names them.
- For non-evolve runs, do not write runtime, agent, skill, workflow, control-plane, generated runtime output, or read-only context files except runtime-declared implementation evidence and `execution-report.json`. `AGENTS.md`, `**/AGENTS.md`, `.codex/**`, `.semgrep/**`, `.harness/**` outside declared evidence/report outputs, `.harness-codex/**`, `harness_codex/**`, `tests/runtime/**`, `completions/**`, the root `harness` launcher, `scripts/install-harness-codex.sh`, and `scripts/bump_runtime_version.py` are not project implementation targets.
- Treat existing `- [x]` checkboxes in the active plan as completed resume state.
- Start implementation from the first remaining `- [ ]` checkbox and execute only unchecked tasks.
- Do not re-run or rewrite checked tasks unless a still-unchecked task is blocked by a direct regression in already completed work.
- Implement only approved code, test, configuration, and implementation-evidence changes.
- Keep writes inside the active ChangeSet and work-item scope declared by the runtime-owned execution-scope artifact.
- Run focused verification for the tasks changed in this attempt.
- Record focused verification commands and results in runtime evidence files and the runtime-declared `execution-report.json`.
- Do not edit the active plan during implementation. Do not update checkbox markers or the `검증 결과` / `Verification Results` section.
- Copy `plan_fingerprint` from `execution-scope.json` into `execution-report.json` so the report is bound to the exact plan that was executed.
- Do not rewrite plan goals, non-goals, input documents, architecture constraints, scope boundaries, task wording, completion policy, or any completed-plan path.
- Report changed files, completed tasks, remaining tasks, focused verification results, evidence paths, and blockers in `execution-report.json`.
- Preserve unrelated worktree changes.

## Explicit non-responsibilities

- Do not invoke another agent, nested Codex process, or workflow.
- Do not select work items, replan, append remediation, or decide whether to resume execution.
- Do not perform or classify final verification.
- Do not move active plans to completed plans.
- Do not create wiki artifacts, commits, branches, or pull requests.
- Do not inspect upstream design artifacts to fill missing plan detail; stop and report the plan blocker instead.

Runtime owns orchestration, final verification, remediation decisions, plan transitions, delivery, and enforcement of ChangeSet write authority.
