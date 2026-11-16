---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# bounded-context

## Purpose

Step of the requirements flow after `subdomain-classification` and before `ubiquitous-language`. Decide the bounded contexts of the request's business, record them in `requirements.md`, and update the project's `CONTEXT-MAP.md`. No persona runs. This stage runs at the high performance tier because a boundary is expensive to reverse, the later Architecture phase treats it as settled input and never compares it again, and the stage writes a project-wide document. It decides contexts only: no aggregates, modules, persistence, communication mechanism or deployment.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` with its confirmed SD table and classes, `BIZ` sections, event flows, `## 4` cross-subdomain events and resolved hotspots, and `stakeholder-analysis.md`, resolved with `harness-spec-path.mjs`.
- `CONTEXT-MAP.md`, `docs/architecture/domain-model.md`, the ADRs they link and `CONTEXT.md`, when present: the existing contexts and the current vocabulary.
- The boundary rule in [ddd-design](../ddd-design/GUIDE.md) and the model lifecycle in [model-continuity](../ddd-design/references/model-continuity.md). They own the criteria, the fair comparison of combined and separate options, the existing-owner-first rule and the `implemented` versus `accepted-target` distinction; apply them as written and do not restate them in the document.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the BC table.

## Prohibited

- Inspecting source or test code. Existing contexts come only from the documents above; when none exist, record `기존 모델 문서 없음` and treat the project as having no existing context.
- Inferring a context from a feature name, a single subdomain, an aggregate or a module, or choosing one by the size of the work.
- Modeling aggregates, entities or modules, choosing a communication or deployment mechanism, or drawing a context diagram.
- Changing a requirement, rule, event or scenario, or reopening a subdomain's confirmed set or class.
- Writing a context as `implemented` when nothing is built, or overwriting an existing context's recorded facts.

## Process

1. Work in the active workspace. Start with `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` and return `blocked` with its output when it fails. Find the documents with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. When `stakeholder-analysis.md` has `판정: 생략`, write nothing, put the skip and its evidence path in the result summary and return `completed/OK`.
3. On resume, read the previous result, `requirements.md`, `CONTEXT-MAP.md` and the actual answers. Continue at step 6 when answers exist; keep decisions already recorded.
4. Map to existing contexts first. For each confirmed subdomain and its `BIZ`, decide whether an existing context already owns the language, rules and data; extension of that context is the first option to test.
5. For what the existing contexts cannot hold, compare the plausible combined and separate options with the ddd-design criteria, using the evidence in `requirements.md`: the vocabulary and event names, the rules each `BIZ` owns, the cross-subdomain events and their reactions, and the actors. Judge every option against the same criteria. Keep the options that remain plausible and the evidence that separates them. Settle by evidence what the evidence settles. Ask only the boundary choices where the plausible options materially change the result, in one batch, in Korean: the options with what each includes and the consequences for responsibility, rules and relationships, a recommended option and its rationale. Return `action_required` / `USER_DECISION_REQUIRED`. With nothing to ask go to step 6.
6. Record the decisions. With answers, a free-text answer is recorded in the user's wording; ask again only when it is ambiguous. Write `### 1.1 바운디드 컨텍스트` of `requirements.md` as the template shows: every `BIZ` is in exactly one context; `책임` and `소유 규칙·데이터` use the `INV` and `BIZ` IDs and terms of the document; `근거` states whether an existing context was extended and which criterion decided, with its source; `비교한 대안` lists the combined and separate options. Add the stage to each touched `BIZ`'s `출처·변경 이력`.
7. Update `CONTEXT-MAP.md` in its own table format and keep its existing contexts and records. Add or update a row per context in `## 2. 경계` with its responsibility, the business inputs and outputs the cross-subdomain events show, and in `비고` the covered subdomains with their class, the status `accepted-target` and the source `docs/specs/<plan-set-id>/requirements.md`. Never mark a new context `implemented`; keep the `implemented` facts of an existing one. Write the relationships between contexts in `## 3. 관계` as business dependencies and reactions, without a communication mechanism.
8. Check before returning: every `BIZ` has exactly one context, no context is only a feature name or a single subdomain's mirror without an evidence-based reason, every row cites its source, every alternative was compared fairly, and the `CONTEXT-MAP.md` diff matches the table. Return `completed/OK` with `requirements.md` and `CONTEXT-MAP.md`.

## Completion

- The BC table covers every `BIZ` with responsibility, owned rules and data, rationale and compared alternatives, and the boundary choices the user made carry their `answers.json` source.
- `CONTEXT-MAP.md` carries the contexts, their covered subdomains with class, their relationships and the `accepted-target` status.
- The runner commits `docs/specs/<plan-set-id>/` and `CONTEXT-MAP.md` when this stage completes. `ubiquitous-language` defines terms per context, and the Architecture phase of `spec-me` takes this decision as settled input.
