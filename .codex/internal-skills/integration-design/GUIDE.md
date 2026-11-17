---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# integration-design

## Purpose

Last step of the tactical design flow, after `application-service` and before `spec-me`. Specify how the bounded contexts exchange what the business needs: the commands, responses and events, and the communication style of each relationship. The inputs are the relationships of `CONTEXT-MAP.md` (with the context that owns the decision, `판단 소유자`) and the consistency decisions of `aggregate-design`. The result is section 5 of `docs/specs/<plan-set-id>/tactical-design.md` and the communication column of the project's model rows. This stage runs at the high performance tier because the choice between a synchronous answer and a later reaction changes what users observe. It asks the user when an integration decision changes the business outcome. It chooses no broker, protocol or framework. An instruction that names a stage, for example "do not touch `application-service`", refers to that stage and its recorded state, never to a file: this stage writes `## 5` of `tactical-design.md` all the same.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/tactical-design.md` sections 1 to 4 (the `CON-xx` decisions and the external effects of the use cases) and `requirements.md`, resolved with `harness-spec-path.mjs`.
- `CONTEXT-MAP.md` `## 3`: each relationship's upstream, downstream, responsibilities, communication contract and `판단 소유자`. It is read-only here; `bounded-context` owns it.
- `CONTEXT.md` for the terms; `docs/architecture/domain-model.md` for the existing communication of the affected rows.
- The [tactical-design.md template](../domain-model/references/template.md), which owns the section shape, and the [shared rules](../domain-model/references/deepening.md) for the final gate rules, deepening and returns.

## Prohibited

- Inspecting source or test code, or choosing a broker, protocol, serialization, framework or deployment unit. Technology choice belongs to `spec-me`.
- Editing `CONTEXT-MAP.md`, adding a relationship the map and the decisions do not evidence, or reassigning a `판단 소유자`.
- Considering Saga or Outbox for a rule that `aggregate-design` did not record as eventual consistency, or applying one to a same-context reaction that needs none.
- Reading a consumer's repository, table or internal type, or sharing a model between contexts; a message carries the business information the receiving context needs and nothing of the sender's internals.
- Asking about an integration choice that the contract, `INV`, `EX` or `AC` already settles, or presenting a recommendation as the user's decision.
- Writing anything in `tactical-design.md` but `## 5`, this stage's rows of `## 6` and the mapping rows that Deepening allows in `### 1.4` and `### 2.2`. Sections 1 to 4 are settled input.

## Process

1. Work in the active workspace. Run the preflight `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` before anything else and, on failure, return `blocked` with its output. Resolve the plan set documents with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the summary and return `completed/OK`. When section 4 is missing, return `blocked` / `INPUT_MISSING`.
3. On resume, read the previous result, section 5 and the actual answers. Continue at step 6 when answers exist and keep decisions already recorded. A previous `blocked` result, with its gate errors, is evidence of that attempt and not the current state: re-run the gate on the current documents and block only on what it still reports for earlier stages, as [the shared rules](../domain-model/references/deepening.md#relaunch-after-a-block) say; otherwise design section 5.
4. List the integrations. Take each `CONTEXT-MAP.md` `## 3` relationship whose contexts own models of this plan set, every `최종` and every `즉시` decision of section 2.3 whose Aggregates sit in different contexts, and every event that section 4 publishes to another context. A relationship that the plan set does not exercise stays out. When a needed relationship is missing or its contract contradicts a decision, return `blocked` / `DEPENDENCY_INCOMPLETE` naming `bounded-context`.
5. Specify each integration in `### 5`: the upstream and downstream contexts, the commands the downstream receives and the responses it returns, the events it reacts to, each named in the glossary's language and carrying the business information that the contract names. Use the `판단 소유자` to place the decision: the owner's context accepts, rejects or finalizes, and the other side carries the owner's outcome. A `미정` owner is a gap to settle by evidence or by the question below.
6. Settle the communication style from the business: a response that the caller needs before it can continue is synchronous; a reaction that may follow later is asynchronous. A `즉시` decision across contexts is never merged and is always synchronous: write an integration row that cites its `CON-xx` in `일관성 결정`, whose `통신 방식` is `동기 확인` (the caller only reads the other context's state, the `조회 전용 Aggregate` of the decision) or `동기 호출`, with its source and `Saga·Outbox` as `없음 — <reason>`; do not ask the user about it. When the contract can only be asynchronous, the decision contradicts section 2.3: return `blocked` / `DEPENDENCY_INCOMPLETE` naming `aggregate-design`. A style that the contract, `INV`, `EX`, `AC` or the `CON-xx` decision settles is recorded with that source. Ask in one batch, in Korean, only when the choice changes what the business observes, for example whether the caller must get a confirmed answer at once or may be told later, what the user sees when the downstream is unavailable, or who decides when the contexts disagree. One question per integration titled with its relationship, an option per choice with its business consequence, a recommended option and a rationale. Return `action_required` / `USER_DECISION_REQUIRED`.
7. Choose Saga or Outbox only for rows that cite an eventual-consistency `CON-xx`: whether a compensation or a reliable publication is needed to keep that decision true, and what happens on failure. Every other row writes `없음`. With answers, record them in the user's wording with the source `answers.json` and the `question_id`; ask again only when an answer is ambiguous.
8. Update the project model rows (`공개 계약 / 통신`), append the decisions of this stage to `## 6` with their sources, and use only terms of `CONTEXT.md`, as the shared rules describe. When the plan set has one context and no relationship, write `해당 없음 — <이유>` in section 5 and record that decision.
9. Return `completed/OK` with `tactical-design.md`, plus `requirements.md`, `docs/architecture/domain-model.md` and `CONTEXT.md` when each changed. The runner, not this stage, then runs the final gate (see Final gate).

## Deepening

An answer can reveal a business rule or exception that `requirements.md` lacks (for example what happens when the downstream rejects): add it to the owning `BIZ` as `INV` or `EX` with its `AC`, the `answers.json` source and a history line, and map it by appending rows to `### 1.4` and `### 2.2`, as the shared rules describe. When it needs a new model, Aggregate, consistency decision, Domain Service or use case, or invalidates an earlier decision, return `blocked` / `DEPENDENCY_INCOMPLETE` naming the earliest stage to reopen and change nothing in its section. A missing or contradicting relationship names `bounded-context`. The shared rules describe how the orchestrator reopens the earlier stage.

## Final gate

The only gate of the tactical flow runs when this stage returns `completed/OK`. The runner checks the whole `tactical-design.md` (sections 1 to 5) against `requirements.md` with `harness-domain-model-check.mjs`, as [the shared rules](../domain-model/references/deepening.md) list, before it commits or records anything. It rejects only those six checks, so the rest of this guide is yours to keep. No earlier stage was checked, so a failure can come from any section. `finish` returns it as `gate_error` with `errors`, each carrying an `owner_stage`, and this stage stays `running`:

- Errors whose `owner_stage` is `integration-design` are this stage's own: repair section 5, rewrite the output file and return again.
- An error owned by an earlier stage means that stage's section is wrong. Earlier sections are settled input, so do not edit them and do not change `requirements.md` to make the gate pass: return `blocked` / `DEPENDENCY_INCOMPLETE` naming the earliest `owner_stage`, with the errors (`code`, `id`, `message`) as the evidence, after restoring `tactical-design.md` to the content it had when this stage started (its committed content) so that the restart finds a clean tree. The orchestrator reports the block and the user reopens that stage with `--restart-requirements true` or `--user-revision true --feedback`, as the shared rules describe; this stage runs again after it.

## Completion

- Section 5 holds an integration row, with its upstream, downstream, messages, communication style and source, for every relationship of the plan set and every cross-context consistency decision (a synchronous row for each `즉시`, an asynchronous one for each `최종`); a choice that changes the business outcome carries the user's answer as its source. Section 6 holds this stage's decisions with sources.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. It adds `docs/architecture/domain-model.md` and `CONTEXT.md` only when this stage names them as artifacts. How `spec-me` consumes the tactical design is decided later.
