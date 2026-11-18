---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# subdomain-classification

## Purpose

Step of the requirements flow after `event-storming` and before `requirements-fix`. Check the boundaries of the subdomain candidates against the event flows, classify each subdomain as core, supporting or generic with a rationale, and have the user confirm the set and the classification in one batch. This is where the candidates stop being hypotheses. No persona runs. Only the business grouping is judged here; bounded contexts, modules and technology are not.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` with its SD table, `BIZ` sections, event flow tables, `## 4` cross-subdomain events and hotspot decisions, and `stakeholder-analysis.md`, resolved with `harness-spec-path.mjs`.
- `CONTEXT-MAP.md` and `docs/architecture/domain-model.md`, read-only and only when present, for a classification an existing area already carries.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the SD table columns, and the [event diagram reference](../event-storming/references/diagrams.md) for the diagrams a changed set needs.

## Prohibited

- Inspecting source or test code, or naming bounded contexts, modules or technology.
- Writing to `CONTEXT.md`, `CONTEXT-MAP.md` or `docs/architecture/`.
- Changing a requirement, rule, event or scenario. Moving a `BIZ` to another subdomain keeps its text and its sources.
- Classifying by technical complexity, size or effort. The classes describe the business, not the work.
- Asking again about a classification the user already gave, or presenting a recommendation as the user's decision.

## Process

1. Work in the active workspace. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` first and return `blocked` with its output when it fails. Resolve every document with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. If `stakeholder-analysis.md` says `판정: 생략`, there is nothing to classify: write no file, record the skip and the evidence path in the summary and return `completed/OK`.
3. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 6 when answers exist; keep decisions already recorded.
4. Validate each candidate's boundary with the event evidence. A `BIZ` whose events are triggered by or reacted to mostly inside another subdomain, a subdomain whose `BIZ` share one purpose, language and actors with a neighbor, or a subdomain that mixes two purposes is a reason to change the set: merge, split or move a `BIZ`. Change the set only when the evidence says so, and record the evidence. Keep a retired `SD` number retired; a split gets a new number.
5. Classify every subdomain from `requirements.md`, not from general knowledge: `core` is what differentiates this request, `generic` is a commodity business such as authentication that any product needs in the same way, `supporting` is needed but does not differentiate. Write a rationale that names the `BIZ`, actors or events it rests on. Reuse a classification that `CONTEXT-MAP.md` already gives an existing area unless this request changes that area's role.
6. Ask in one batch, in Korean. Ask one question per subdomain with the options `core`, `supporting` and `generic`, showing its `BIZ` and the proposed boundary, a recommended option and the rationale. When step 4 changed the set, add one question that shows the set before and after with the evidence and offers keeping the candidates as they were. Return `action_required` / `USER_DECISION_REQUIRED`. With the answers, apply them: a free-text answer that changes the set or the class is recorded in the user's wording. Ask again only when an answer is ambiguous.
7. Write `requirements.md`: the SD table with `분류`, `근거` and `상태: confirmed`, each rationale ending with its source `answers.json` and the `question_id`; the `BIZ` headings and the table's `포함 업무` for every moved `BIZ`; the `## 4` table recomputed from the final set. Add the stage to each touched `BIZ`'s `출처·변경 이력`.
8. When the set changed, rewrite the affected `SD-xx.events.puml` files and `cross-subdomain.events.puml` from the final tables, remove the diagrams of retired subdomains, render each with the local renderer as the [event diagram reference](../event-storming/references/diagrams.md) describes, and fix the links in `## 4`. A render failure blocks completion.
9. Check before returning: every `BIZ` belongs to exactly one subdomain, every subdomain is `confirmed` with a class and a sourced rationale, the `## 4` table and the diagrams match the final set, and no text of any `BIZ` changed. Return `completed/OK` with `requirements.md` and, when diagrams changed, the `diagrams/events` directory.

## Completion

- Every SD row has `분류` of `core`, `supporting` or `generic`, a `근거` and `상태: confirmed`; the set was confirmed by the user's answers.
- Any change to the set is backed by event evidence, and the diagrams and `## 4` agree with it.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `requirements-fix` and then `bounded-context` read the confirmed subdomains and their classes.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Subdomain의 분류와 근거를 확인한다. 기존 분류 변경은 사용자에게 확인한다.
