---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# application-service

## Purpose

Step of the tactical design flow after `domain-service` and before `integration-design`. For every business activity, design the use case that coordinates the Aggregates and Domain Services: the call order, the transaction boundaries, the repositories and the external effects. It decides nothing about the business. The result is section 4 of `docs/specs/<plan-set-id>/domain-model.md` and the transaction column of the project's model rows. No persona runs and the user is not asked.

## Inputs

- `docs/specs/<plan-set-id>/domain-model.md` sections 1 to 3 and `requirements.md` (`BIZ`, `INV`, `EX`, `AC`, event flows), resolved with `harness-spec-path.mjs`.
- `CONTEXT.md` for the terms; `docs/architecture/domain-model.md` for existing use cases and rows.
- The [domain-model.md template](../domain-model/references/template.md), which owns the section shape, and the [shared rules](../domain-model/references/deepening.md) for the gate, deepening and returns.

## Prohibited

- Inspecting source or test code, or choosing a framework, transaction mechanism, repository technology or message broker.
- Making a domain decision: a rule, a branch on business state or a calculation belongs to an Aggregate method or a Domain Service. An Application Service calls them and passes the result on.
- One transaction that changes more than one Aggregate, or reaching into another Aggregate's state instead of its ID.
- A use case for an activity that an external system owns alone, a pass-through service that adds no coordination, or a repository for anything that is not an Aggregate.
- Changing sections 1 to 3, or asking the user.

## Process

1. Work in the active workspace. Start with `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with its output if it fails. Find the documents with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the summary and return `completed/OK`. When section 3 is missing or its gate fails, return `blocked` / `INPUT_MISSING`.
3. On resume, read the previous result and section 4, keep rows already recorded and finish the missing ones.
4. For each `BIZ` whose models are not all external, list the use cases the normal and exception scenarios need. A reaction to another subdomain's event (`## 4` of `requirements.md`) is its own use case, because it runs in its own transaction.
5. Write `### 4` one row per use case: the name, its BC, the `BIZ` IDs, the call order using Aggregate behaviours and Domain Service behaviours exactly as sections 2 and 3 name them, the transaction boundaries, the repositories and the external effects. Load and save through one repository per Aggregate. Write the boundary as `T1: <Aggregate>` per transaction; a reaction that section 2.3 separates by eventual consistency gets its own transaction with its `CON-xx`. A read-only use case writes `없음 — <이유>`. Place an external effect (a call to an external system, an event) after the commit it depends on and name it.
6. Update the project model rows: the transaction and repository of each Aggregate in `데이터 / transaction`, as the shared rules describe. Append the decisions of this stage to `## 6` with sources, using only terms of `CONTEXT.md`.
7. Run `node .codex/scripts/harness-domain-model-check.mjs --workspace-root <workspace_root> --stage application-service` and repair the documents until it passes. Return `completed/OK` with `domain-model.md`, plus `docs/architecture/domain-model.md` and `CONTEXT.md` when each changed.

## Deepening

This stage never adds a business rule. A scenario step that no Aggregate behaviour or Domain Service covers, or a use case that would need two Aggregates in one transaction, is not solved here: return `blocked` / `DEPENDENCY_INCOMPLETE` naming `aggregate-design` or `domain-service`, or `blocked` / `INPUT_MISSING` when the requirements do not say what the step does. Nothing in earlier sections is edited. The shared rules describe how the orchestrator reopens the earlier stage.

## Completion

- Every `BIZ` that is not owned only by an external system appears in at least one use case, and every use case names its call order, its transactions, its repositories and its external effects.
- Every transaction changes exactly one Aggregate, and each eventual-consistency boundary cites its `CON-xx`.
- The gate passes and section 6 holds this stage's decisions with sources.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. It adds `docs/architecture/domain-model.md` and `CONTEXT.md` only when this stage names them as artifacts. `integration-design` reads the external effects and the boundaries.
