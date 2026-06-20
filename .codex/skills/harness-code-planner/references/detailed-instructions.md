# harness-code-planner Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-code-planner/SKILL.md`

---
name: harness-code-planner
description: Create or maintain an executor-ready implementation plan for one active ChangeSet work item. Use after a ChangeSet and one work-item slice exist and before coding starts, or when updating/completing that work-item plan. The skill keeps planning scoped to the active ChangeSet, writes only docs/plans/active/<WORK-ITEM-ID>/plan.md, and moves it to docs/plans/completed/<WORK-ITEM-ID>/plan.md only after all checkbox tasks and build/test/e2e/runtime-server/static-analysis verification are complete.
---

# Harness Code Planner

## Purpose

Create or update the executor-ready implementation plan for exactly one work item inside an active ChangeSet.

The planner turns a ChangeSet-local work-item slice, architecture constraints, repository settings, canonical domain references, and approved technical decisions into `docs/plans/active/<WORK-ITEM-ID>/plan.md`.

The planner does not implement code. It does not update integrated source-of-truth design documents. Integrated docs are synced after implementation and verification by the docs-sync/complete workflow.

## Work-item Contract Summary

Plan exactly one work-item slice from `docs/changes/active/<CHG-ID>.md` into `docs/plans/active/<WORK-ITEM-ID>/plan.md`, then move it to `docs/plans/completed/<WORK-ITEM-ID>/plan.md` only after verification is complete.

Always read the selected work-item slice, `ARCHITECTURE.md`, `.codex/repository-settings.md`, approved technical decisions, and the ChangeSet Before/After delta. Use `docs/use-cases/<UC-ID>/` for a use-case work item and `docs/maintenance/<MAINT-ID>/` for a maintenance work item. Integrated documents under the design documentation area are source-of-truth references only. They are not the primary planning input.

### Use-case work-item slice

Required:

- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `docs/use-cases/<UC-ID>/technical-decisions.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`

Optional:

- `docs/use-cases/<UC-ID>/requirements-slice.md`
- `docs/use-cases/<UC-ID>/domain-impact.md`
- `docs/use-cases/<UC-ID>/aggregate-delta.md`
- `docs/use-cases/<UC-ID>/source-map.md`

### Maintenance work-item slice

Required:

- `docs/maintenance/<MAINT-ID>/change-intent.md`
- `docs/maintenance/<MAINT-ID>/affected-files.md`
- `docs/maintenance/<MAINT-ID>/verification-goal.md`

Optional:

- `docs/maintenance/<MAINT-ID>/technical-decisions.md`
- `docs/maintenance/<MAINT-ID>/domain-impact.md`
- `docs/maintenance/<MAINT-ID>/source-map.md`

## Verification and Domain Planning Requirements

- Stop when `technical-decisions.md` is not explicitly approved.
- Include build and test verification such as `./gradlew build` and `./gradlew test`, or the concrete repository equivalents from `.codex/test-gate.yaml` and `.codex/repository-settings.md`.
- Include E2E or maintenance verification tied to the approved E2E/verification goal.
- Include `domain-impact.md`, `aggregate-delta.md`, and canonical references such as `docs/domain/<BC-ID>/aggregates/<AGG-ID>.md` whenever the work item affects domain elements.
- Add Compatibility tests when another use case shares a modified domain element.
- Block or coordinate when another active ChangeSet modifies the same canonical domain element.
- For browser-accessible UI that calls another local origin, require a same-origin proxy or backend CORS configuration for the frontend origin, methods, and request headers.
- For runnable applications, preserve the versioned launcher contract: `scripts/run-app-infra.sh`, `scripts/run-app-server.sh`, `scripts/check-app-infra.sh` when an infrastructure readiness probe is needed, local infrastructure such as `compose.yaml`, and verification through `harness run app`.


## Reference Map

Load only the reference needed for the current step. Content was split from this file without semantic changes.
- gates.md: ## Scope Model to ## Invocation.
- invocation.md: ## Invocation to ## Plan Rules.
- plan-rules.md: ## Plan Rules to ## Embedded Test Planning Standards.
- test-standards.md: ## Embedded Test Planning Standards to ## Output Template.
- plan-template.md: ## Output Template to EOF.
