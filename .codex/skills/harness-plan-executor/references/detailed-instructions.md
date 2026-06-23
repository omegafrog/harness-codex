# harness-plan-executor Runtime Boundary

- Skill entrypoint: `.codex/skills/harness-plan-executor/SKILL.md`

## Purpose

This document records the responsibility boundary for the legacy plan-executor name. The runtime is the sole orchestrator for implementation workflows.

## Ownership map

| Responsibility | Owner |
|---|---|
| Select ChangeSet and work item | Runtime |
| Materialize and sequence workflow steps | Runtime |
| Execute bounded code/test/config tasks | `implementation_executor` with `harness-implementation-executor` |
| Run final verification and security gates | Runtime validator and reviewer steps |
| Classify verification outcomes | Runtime decision step |
| Append remediation and retry | Runtime record/loop step |
| Move active plan to completed plans | Runtime git boundary |
| Create delivery artifacts | Runtime delivery boundary |

## Constraints

- Never pass this skill to `implementation_executor`.
- Do not invoke agents, nested processes, or workflows from this document.
- Do not prescribe direct code edits, verification classification, remediation, plan moves, commits, or pull requests.
- Keep the active plan in place until the runtime completion contract authorizes its transition.

The focused implementation executor returns changed files, focused verification evidence, and blockers. Runtime code combines that result with verifier output to choose the next stage.
