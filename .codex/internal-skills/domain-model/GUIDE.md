---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# domain-model

## Purpose

First step of the tactical design flow, after `requirements-fix` and before `aggregate-design`. Turn the fixed `requirements.md` into Entity and Value Object candidates per bounded context, and map every business activity, rule and event to them. The result is section 1 of `docs/specs/<plan-set-id>/tactical-design.md` and the affected rows of the project's `docs/architecture/domain-model.md`. The bounded contexts and the context map are settled input and are never compared again. This stage runs at the high performance tier because every later stage builds on its model, and it is the only tactical stage that inspects code. The user is not asked: when the evidence is insufficient the stage blocks and points at a requirements revision. A user instruction that names a stage, such as "leave `domain-model` as it is", refers to that stage and its recorded state, never to a file: it does not keep this stage from writing `## 1` of `tactical-design.md`.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` with `상태: fixed`: the `BIZ` sections with `INV`, `EX`, `AC` and event flows, the SD table with its classes, `### 1.1 바운디드 컨텍스트`, `## 3` terms and `## 4` events. `stakeholder-analysis.md` is resolved with `harness-spec-path.mjs`.
- `CONTEXT-MAP.md` and `CONTEXT.md`, read as settled input; `docs/architecture/domain-model.md` and the ADRs it links, when present.
- The [tactical-design.md template](references/template.md), which owns the document shape, and the [shared rules](references/deepening.md) for the final gate rules, deepening and returns.
- [code-research](../code-research/GUIDE.md), delegated to `code_researcher`, for an existing project only.

## Prohibited

- Comparing, splitting or merging bounded contexts again, changing the context map or an SD class. A boundary that looks wrong is an iterative-deepening block, not an edit.
- Deciding Aggregates, Domain Services, Application Services, persistence, APIs or messages. This stage names models and maps requirements to them.
- Inspecting code outside the one `code-research` delegation, or reading code to find business terms.
- Modeling a rule, event or term with no evidence in `requirements.md`, writing a new business rule, or marking an unbuilt model `implemented`.
- Naming a model with a word that `CONTEXT.md` or the `## 3` table does not cover, or reviving a retired term.
- Asking the user.
- Writing anything in `tactical-design.md` but `## 1` and this stage's rows of `## 6`. The later sections belong to the later stages.

## Process

1. Work in the active workspace. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with its output when it fails. Resolve `requirements.md`, `stakeholder-analysis.md` and `tactical-design.md` with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, record the skip and its evidence path in the summary and return `completed/OK`. When `requirements.md` is not `fixed`, return `blocked` / `INPUT_MISSING`.
3. On resume, read the previous result and `tactical-design.md`. When section 1 exists, only finish what is missing; on a user revision follow the shared rules.
4. Establish the existing model. For an existing project, delegate `code-research` to a fresh read-only `code_researcher` with the BC names of `### 1.1` and the `INV`/`EX` IDs, and ask for each BC's current models, their roots or owners, state, enforcement methods, repositories and transaction owners, with `file:line` and the inspected commit. Without existing model documents and code, write `기존 모델 없음 — <확인한 문서와 경로>`. Record both in `### 1.1`; keep documented intent and observed code apart. Reuse an existing owner when it can hold the change, and give the reason when a new model is proposed.
5. Fix the depth per SD class in `### 1.2`: `core` gets a rich model, `supporting` only what its rules need, `generic` a minimal model or an `외부 시스템` marker that leaves build-versus-buy undecided.
6. Find the candidates in `### 1.3` from the `BIZ` sections, the event flows and the rules. An Entity has an identity that outlives the events and a lifecycle the requirements describe; a Value Object matters only by its value and is replaced, not changed. Give each its BC, the lifecycle or value meaning, its evidence (BIZ, INV, EX, event) and `현재 상태`. Check each name against `CONTEXT.md`; run a new concept through the language lifecycle as the shared rules say.
7. Map in `### 1.4`: every `BIZ`, `INV` and `EX`, and every event and glossary term of each BC, to the candidates of that BC. An event that reacts in another subdomain maps to the receiving BC's model. A rule that no candidate can own means a model is missing: add the candidate, or block when the evidence does not support one.
8. Update the project model rows for the models this stage touched, as the shared rules describe.
9. Append the decisions of this stage to `## 6`: why each model is an Entity, a Value Object or an external system, what was extended and what alternatives were rejected, each with its source. Section 6 needs at least one row.
10. Return `completed/OK` with `tactical-design.md`, plus `docs/architecture/domain-model.md` and `CONTEXT.md` when each changed.

## Deepening

This stage never adds a business rule. When the evidence is missing or contradictory, return `blocked` / `INPUT_MISSING` naming the `BIZ`, `INV` or `EX` and the revision it needs; when a bounded context or SD class cannot hold the model, return `blocked` / `DEPENDENCY_INCOMPLETE` naming `bounded-context` or `subdomain-classification`. The orchestrator reopens through `--restart-requirements` or a `requirements-fix` user revision as [the shared rules](references/deepening.md) describe.

## Completion

- Section 1 of `tactical-design.md` carries the existing-model record (or `기존 모델 없음`), the depth per BC, the models with their evidence and the requirement mapping, and section 6 records its decisions with sources.
- The affected rows of `docs/architecture/domain-model.md` are `implemented` only where code showed it; every other row is `accepted-target`.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. It adds `docs/architecture/domain-model.md` and `CONTEXT.md` only when this stage names them as artifacts. `aggregate-design` reads this section as settled input.
