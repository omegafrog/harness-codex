---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# domain-service

## Purpose

Step of the tactical design flow after `aggregate-design` and before `application-service`. Give a Domain Service to each domain decision that no Entity or Value Object naturally owns, which is the set of rules `aggregate-design` handed over in section 2.2. A Domain Service decides; it does not coordinate. The result is section 3 of `docs/specs/<plan-set-id>/tactical-design.md` and the enforcement column of the project's model rows. No persona runs and the user is not asked. When the user says not to reopen `aggregate-design`, the instruction refers to that stage and its recorded state, never to a file; this stage still writes `## 3` of `tactical-design.md`.

## Inputs

- `docs/specs/<plan-set-id>/tactical-design.md` sections 1 and 2 and `requirements.md` (`INV`, `EX`, `AC`, event flows), resolved with `harness-spec-path.mjs`.
- `CONTEXT.md` for the terms; `docs/architecture/domain-model.md` for existing services.
- The [tactical-design.md template](../domain-model/references/template.md), which owns the section shape, and the [shared rules](../domain-model/references/deepening.md) for the final gate rules, deepening and returns.

## Prohibited

- Scope: a Domain Service that traces to no existing requirement ID, or a question whether a feature belongs in scope ([No new scope](../domain-model/references/deepening.md#no-new-scope)).
- Inspecting source or test code, or reading an existing service from code.
- Orchestration, transaction boundaries, persistence, repository calls, publishing events or any external effect. Those belong to `application-service`.
- Taking a rule that an Aggregate method or a Value Object already enforces, or moving a decision out of an Entity or Value Object that can own it naturally.
- Adding a service that no rule needs, a pass-through wrapper, or a domain rule that `requirements.md` does not state.
- Changing sections 1 or 2, or asking the user.
- Writing anything in `tactical-design.md` but `## 3` and this stage's rows of `## 7`. Sections 1 and 2 are settled input and the later sections belong to the later stages.

## Process

1. Work in the active workspace. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with the output when it fails. Look up the documents with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, record the skip and its evidence path in the summary and return `completed/OK`. When section 2 is missing, return `blocked` / `INPUT_MISSING`.
3. On resume, read the previous result and section 3, keep rows already recorded and finish the missing ones.
4. Collect every rule that section 2.2 marks `Domain Service`, and every domain decision in the `BIZ` sections that needs several Aggregates' data or a policy no single model owns. For each, test the natural owner once more: if one Entity or Value Object can decide it from its own state, it is an Aggregate behaviour or a Value Object rule and `aggregate-design` made a wrong hand-over, which is a block (see Deepening), not a service.
5. Write `### 3`: one row per service with a domain-language name, its BC, the decision it makes in one sentence (inputs, and the result as a domain value), the models it uses, the rule IDs it enforces, its behaviour with the inputs the decision needs, and why no Entity or Value Object owns it. A service is stateless and has no side effect. When no rule needs a service, write `해당 없음 — <이유>` and append that decision to `## 7`.
6. Update the project model rows: the services' rules in `규칙 ID → enforcement`, as the shared rules describe. Append the decisions of this stage to `## 7` with sources, using only terms of `CONTEXT.md`.
7. Return `completed/OK` with `tactical-design.md`, plus `docs/architecture/domain-model.md` and `CONTEXT.md` when each changed.

## Deepening

This stage never adds a business rule. A decision that the requirements leave unstated returns `blocked` / `INPUT_MISSING` naming the `BIZ`, `INV` or `EX`. A rule that an Aggregate should own, or a service that would need an Aggregate or consistency decision to change, returns `blocked` / `DEPENDENCY_INCOMPLETE` naming `aggregate-design`; nothing in section 2 is edited. The shared rules describe how the orchestrator reopens the earlier stage. Every such block names the earliest owning stage and the gap in the result fields that [the shared rules](../domain-model/references/deepening.md#automatic-rewind-to-the-owner) describe; the orchestrator then reopens that stage by itself without asking the user.

## Completion

- Section 3 holds one service row with a behaviour for each rule that section 2.2 hands to a Domain Service (or says `해당 없음 — <이유>`), and section 7 holds this stage's decisions with sources.
- Services are stateless decisions: no coordination, persistence or external effect appears in a row.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. It adds `docs/architecture/domain-model.md` and `CONTEXT.md` only when this stage names them as artifacts. `application-service` calls these services in its use cases.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
