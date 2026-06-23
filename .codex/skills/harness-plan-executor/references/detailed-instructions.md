# harness-plan-executor Runtime Boundary

- Skill entrypoint: `.codex/skills/harness-plan-executor/SKILL.md`

## Purpose

This document records the runtime policy for the legacy plan-executor name. The runtime is the sole orchestrator for implementation workflows; this document is never supplied to `implementation_executor`.

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

## Runtime scope and verification policy

The runtime operates on one targeted `docs/plans/active/<UC-ID>/plan.md` at a time. Do not execute or complete other active UC plans while the runtime is handling that targeted plan.

The runtime treats `docs/use-cases/<UC-ID>/e2e-goal.md` as the UC E2E goal and business acceptance contract. It records implementation-specific test suite evidence in `docs/plans/active/<UC-ID>/verification.md` or the active plan, and applies `.codex/test-gate.yaml` after the bounded implementation attempt.

The runtime can require `./gradlew test`, `./gradlew e2eTest`, build, static analysis, and service verification according to the active plan and repository configuration. It requires Playwright MCP browser verification from the end user's perspective only when the approved path has a browser-accessible UI; otherwise using the existing API/runtime verification path is permitted with a recorded reason. API-only or HTTP-only probes may support diagnosis but do not replace an approved browser flow. The runtime verifies proxy or CORS/preflight behavior when the browser and backend use different origins.

## Runtime classification policy

Only for `IMPLEMENTATION_FAILURE`, the runtime appends a bounded remediation task and routes back to the implementation step. For `UNCLEAR_E2E_GOAL`, `DOCUMENT_DELTA_CONFLICT`, `UPSTREAM_DESIGN_CONFLICT`, and `ENVIRONMENT_BLOCKER`, do not add remediation tasks; retain the active plan and report the owning upstream or environment boundary.

## Runtime completion policy

The runtime moves `docs/plans/active/<UC-ID>/plan.md -> docs/plans/completed/<UC-ID>/plan.md` only when all of these are true:

- every required plan task is complete;
- the UC E2E goal and business acceptance contract are satisfied;
- required verification evidence and test-gate results pass;
- the runtime completion contract authorizes the git boundary.

## Constraints

- Never pass this skill to `implementation_executor`.
- Do not invoke agents, nested processes, or workflows from this document.
- Do not prescribe direct code edits, verification classification, remediation, plan moves, commits, or pull requests.
- Keep the active plan in place until the runtime completion contract authorizes its transition.

The focused implementation executor returns changed files, focused verification evidence, and blockers. Runtime code combines that result with verifier output to choose the next stage.
