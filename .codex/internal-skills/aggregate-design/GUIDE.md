---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# aggregate-design

## Purpose

Step of the tactical design flow after `domain-model` and before `domain-service`. Group the Entities and Value Objects of section 1 into Aggregates by the invariants that must hold together, name the behaviour that enforces every rule, and decide the consistency of every rule that spans Aggregates. The result is section 2 of `docs/specs/<plan-set-id>/domain-model.md` and the Aggregate columns of the project's model rows. This stage runs at the high performance tier because a boundary is expensive to reverse and the consistency choice changes what the business observes. Consistency is a business decision, so this stage asks the user when the requirements do not settle it.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/domain-model.md` section 1 and `requirements.md` (`BIZ`, `INV`, `EX`, `AC`, event flows, `## 4`), resolved with `harness-spec-path.mjs`.
- `CONTEXT-MAP.md` and `CONTEXT.md` for the settled contexts and terms; `docs/architecture/domain-model.md` for existing Aggregates.
- The [domain-model.md template](../domain-model/references/template.md), which owns the section shape, and the [shared rules](../domain-model/references/deepening.md) for the gate, deepening and returns.

## Prohibited

- Inspecting source or test code; existing Aggregates come from section 1 and the project model document only.
- Changing section 1 or the bounded contexts, or adding a model that section 1 does not declare. The only addition allowed there is a mapping row for a new rule (see Deepening).
- Mapping one `BIZ` to one Aggregate mechanically, or creating an Aggregate that no invariant needs. A single Entity may be an Aggregate; a model without its own invariant joins the Aggregate whose invariant it serves.
- Letting an Aggregate hold another Aggregate's object: other Aggregates are referenced by ID only, and one transaction changes one Aggregate.
- Choosing a consistency model by technical preference, or asking about one that `INV`, `EX` or `AC` already settles.
- Choosing persistence, messaging or frameworks, or deciding how an eventual-consistency rule is delivered (`integration-design` does).

## Process

1. Work in the active workspace. Begin with the preflight, `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`; a failure returns `blocked` with its output. Resolve the documents with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the summary and return `completed/OK`. Without a fixed `requirements.md` and a section 1 that passes its gate, return `blocked` / `INPUT_MISSING`.
3. On resume, read the previous result, section 2 and the actual answers. Continue at step 6 when answers exist and keep decisions already recorded.
4. Group by invariants. For each Entity and Value Object, find the rules (`INV`, `EX`) that must be true at the same moment as other models' state; those models share an Aggregate. Prefer an existing Aggregate that section 1 marks `implemented` and extend it when it can hold the change. Choose the Root as the one Entity every outside call goes through; write its identity, members, the behaviours that change state and the references to other Aggregates (by ID). A model that no invariant ties to another stands alone as its own Aggregate only when it has its own rules.
5. Assign every `INV` and `EX` in `### 2.2` to the Aggregate that owns it and to the behaviour that enforces it, using root method names that also appear in `주요 행위`. A rule owned by an `외부 시스템` is `외부 시스템: <모델>`. A rule that needs more than one Aggregate's data without belonging to either, or a judgement no Entity naturally owns, is `Domain Service`; `domain-service` fills it.
6. Settle consistency for each rule that involves two or more Aggregates. Immediate consistency (both must change together or not at all) means one Aggregate: merge and record it. Eventual consistency allowed means separate Aggregates. First read `INV`, `EX`, `AC` and the event flows: a rule that states a deadline, an all-or-nothing outcome or an acceptable delay settles it, and its source is that ID. When nothing settles it, ask in one batch, in Korean: one question per rule titled with its ID, an option for each choice with the business consequence (what the user sees if the second change fails or lags, and what the immediate option blocks), a recommended option and a rationale from the request. Return `action_required` / `USER_DECISION_REQUIRED`.
7. With the answers, record `### 2.3`: one `CON-xx` per such rule with the consistency, the decision (the merge or the separation and what each side may observe in between) and the source `answers.json` with the `question_id`. Redo the grouping where a merge changed it. A free-text answer is recorded in the user's wording; ask again only when it is ambiguous.
8. Update the project model rows (Root, `규칙 ID → enforcement`, the Aggregate boundary of `데이터 / transaction`) as the shared rules describe, append the decisions of this stage to `## 6` with their sources, and use only terms of `CONTEXT.md`.
9. Run `node .codex/scripts/harness-domain-model-check.mjs --workspace-root <workspace_root> --stage aggregate-design` and repair the documents until it passes. The runner enforces this gate on `completed/OK` and returns a failing result as `gate_error`. Return `completed/OK` with `domain-model.md`, plus `requirements.md`, `docs/architecture/domain-model.md` and `CONTEXT.md` when each changed.

## Deepening

An answer or the grouping can reveal a rule that `requirements.md` lacks: add it to the owning `BIZ` as `INV` or `EX` with its `AC`, the `answers.json` source and a history line, and map it to a model by appending a row to `### 1.4` and its enforcement to `### 2.2`, as the shared rules describe. When it needs a model that section 1 lacks, or invalidates a section 1 decision (a model that is really two, an Entity that is a Value Object), return `blocked` / `DEPENDENCY_INCOMPLETE` naming `domain-model` and change nothing there. The shared rules describe how the orchestrator reopens the earlier stage.

## Completion

- Every Entity belongs to exactly one Aggregate, other Aggregates are referenced by ID only, and every `INV` and `EX` has an owning Aggregate and an enforcing behaviour, or is handed to a Domain Service or an external system.
- Every rule that spans Aggregates has a `CON-xx` with `즉시` (merged) or `최종` (separate) and a user-decision or requirements source.
- The gate passes and section 6 holds this stage's decisions with sources.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. It adds `docs/architecture/domain-model.md` and `CONTEXT.md` only when this stage names them as artifacts. `domain-service` and `integration-design` read these decisions as settled input.
