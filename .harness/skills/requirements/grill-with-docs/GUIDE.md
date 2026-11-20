---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# grill-with-docs

## What it does

`grill-with-docs` is the shared interview protocol for a calling workflow stage. It checks that stage's coverage and gathers only material questions the stage owns. It batches independent decisions when the caller requests batch mode.

It incorporates the question selection and interaction contract of [grilling](../grilling/GUIDE.md). The stage remains the workflow owner: it supplies the canonical documents, coverage checklist, evidence boundaries and batch policy, then applies accepted answers to its own artifacts.

## Stage-hosted invocation

This GUIDE is applied inside a stage execution, not launched as a separate workflow stage or a second user conversation. Before returning user questions, the stage MUST read and follow this GUIDE and `references/how-to-grill.md`.

The calling stage supplies its stage ID and decision ownership, exact canonical input/output paths and artifact IDs, full applicable coverage checklist (including settled and `NOT_APPLICABLE` topics), prior `answers.json` and authoritative decisions, evidence boundaries, batch mode and dependency order. Use that checklist as the complete interview scope. Do not invent optional scope or take a decision from another stage. The caller's GUIDE controls which gaps warrant questions and the order in which decisions are resolved.

The caller's checklist must enumerate the decision dimensions needed by the requested behavior, not only generic completeness categories. Derive applicable dimensions from the user's named actions and the stage's explicit coverage rules; for example, account registration/login can require registration inputs, login identifier, identifier rules and password policy. A broad row such as "business rules are settled" does not cover these dimensions. When a downstream design stage returns a missing business requirement to this owner, the reopened stage adds that exact gap as a required topic, checks prior answers first, and keeps interviewing until it is settled or reasoned `NOT_APPLICABLE`.

`grill-with-docs` selects, deduplicates, groups and phrases questions. It does not write the caller's documents, IDs, glossary or ADRs in stage-hosted mode. Return questions in the caller's `result.questions` using `.harness/schemas/question.schema.json`; put relevant stage artifact IDs in the title, and option consequences and recommendation in schema fields. Set `question_id` to `${execution_id}:${index + 1}` in returned order; the execution runtime validates this deterministic value. After answers arrive, the caller reads stored answers, classifies them, reruns its checklist and updates only its owned artifacts.

## Required preparation

Before asking the first question:

1. MUST read `references/how-to-grill.md`.
2. MUST receive or derive a coverage checklist from the calling skill.
3. MUST respect the calling skill's evidence and inspection boundaries. This skill does not grant access to sources that the caller prohibits.
4. Classify every coverage topic as one of:
   - `SETTLED`: settled by authoritative input, evidence, or a documented reasonable default within the requested core scope.
   - `PARTIAL`: some required information is known, but a material gap remains.
   - `UNRESOLVED`: a material decision or required behavior is not settled.
   - `NOT_APPLICABLE`: the topic does not apply, with a concrete reason.
5. Distinguish descriptive facts from stakeholder decisions.

Within the evidence allowed by the calling skill, repository evidence, existing code, tests, specs, ADRs, and project documents may settle descriptive facts and routine details. Do not infer new product intent or optional scope from them. For a required outcome with materially different plausible interpretations that cannot be reasonably resolved, ask or honor explicit delegation; identify defaults and delegated choices accurately instead of presenting them as user-supplied decisions.

## Interview loop

Select questions using the shared [grilling](../grilling/GUIDE.md) criteria. Use repository evidence and settled decisions to resolve implementation details, and record engineering rationale without presenting it as a user's decision.

While a decision necessary for the requested core behavior is materially `PARTIAL` or `UNRESOLVED` and cannot be resolved from existing evidence or a reasonable default:

1. In batch mode, inspect every applicable coverage topic and gather all currently identifiable material decisions before returning any questions. Reuse settled answers and explicit delegation. Identify dependencies between decisions; put every independently answerable decision into one `questions` array, including relevant scope, behavior, failures and acceptance conditions. Do not stop gathering at the first gap. Ask dependent follow-ups only after their prerequisite answers make them meaningful. A single question is valid when it is the only currently answerable material decision. Outside batch mode, select the highest-impact unresolved decision and ask one focused question.
2. Make each question focused and independently answerable; include a recommended answer and a concise reason for it.
3. Wait for the user's responses to the batch before proceeding. Classify each response separately and reassess the full coverage checklist before the next batch.
4. Classify the response before updating coverage. A response is not automatically a decision.
   - `ACCEPTED`: the user explicitly chooses, confirms, or clearly authorizes one answer.
   - `REJECTED`: the user clearly rejects the recommendation or the current alternatives without settling a replacement.
   - `QUESTION_OR_CHALLENGE`: the user asks a follow-up question, disputes an assumption, requests more context, or points out a concern.
   - `ALTERNATIVE_PROPOSAL`: the user suggests another option, condition, exception, or trade-off but does not explicitly confirm it as the final rule.
5. Answer or investigate `QUESTION_OR_CHALLENGE` and `ALTERNATIVE_PROPOSAL`. Ask again only if a material stakeholder choice remains unresolved; if the response settles or explicitly delegates it, continue accordingly. Do not infer acceptance from a question or an unconfirmed alternative. Preserve the accepted parts of partial answers and ask only for remaining dependent decisions; do not restart the interview or mark the parent topic settled while a required child topic is open.
6. Treat `REJECTED` as unresolved unless the user also explicitly settles a replacement. Ask a focused follow-up that resolves the remaining choice.
7. `ACCEPTED`, an unambiguous answer, or explicit delegation may settle the stakeholder decision including its material conditions and exceptions. Resolve delegated and ordinary engineering details from evidence and the approved scope; identify their author and rationale accurately.
8. Reassess affected existing terms as model meaning/ownership/lifecycle settles, not only newly coined terms. Read the [proactive language review](../../design/domain-model/domain-model/references/language-lifecycle.md). Propose implied definition/rename/retirement changes yourself; resolve material meaning choices in this same interview. Once the model decision settles the naming consequence, update it without an extra standalone rename-approval round. Classify the resulting terms using the durable-vocabulary placement rules.
9. In stage-hosted mode, return glossary or context-map consequences to their owning stage; do not edit those artifacts yourself. In standalone mode, update them only when the caller explicitly assigns ownership.
10. Report reusable implementation preferences to the caller. Write them only when the caller owns the guidance file and explicitly permits the update. Do not record developer/skill instructions, inferred preferences, or product decisions as preferences.
11. Report reusable test-running preferences to the caller. Write them only when the caller owns the guidance file and explicitly permits the update.
12. Record a durable, expensive-to-reverse decision in an ADR when it is worth preserving, but only after the decision is settled.
13. Repeat until no material stakeholder decision remains unresolved. Complete ordinary engineering details without turning each one into an interview question.

### Response confirmation gate

Never infer consent from conversational momentum. In particular, do not interpret “what about...?”, “could we instead...?”, “I suggest...”, “why not...?”, or a conditional statement as acceptance of the recommended answer.

When the user responds with a question or proposal:

1. Answer the question or acknowledge the proposal and explain its implications.
2. State the currently pending decision in one sentence.
3. Ask for a concrete choice only if a material stakeholder decision remains unresolved. When the response delegates the choice or settles it, continue using the authorization given.

Example:

> User: What if administrators need to bypass this limit?
>
> Agent: That would make the limit apply to regular users only, with an administrator exception. The pending decision is whether the limit is universal or bypassable by administrators. Should I record the administrator exception?

Ask only when an unresolved decision is necessary for the requested core behavior, materially changes its outcome, and cannot be resolved using existing evidence or a reasonable platform default. Do not invent optional features or policies to create questions. Resolve routine details using project evidence and reasonable judgment; do not represent defaults as user-approved decisions.

Do not ask questions merely to increase question count. Prefer questions that expose assumptions, boundaries, counterexamples, failures, conflicts, and trade-offs.

## Completion gate

The interview MAY finish only when all of the following are true:

- Every required coverage topic is `SETTLED` or `NOT_APPLICABLE`.
- Material stakeholder decisions are supported by the user's choice or explicit delegation; implementation choices identify their engineering basis.
- No material contradiction remains between user answers, specs, ADRs, allowed evidence, or earlier decisions.
- Blocking open questions are resolved.
- In stage-hosted mode, durable document updates are complete only when the owning stage has recorded them in its canonical artifacts.
- Ask a completion question only when an unresolved material stakeholder decision remains that the available context cannot settle.

Zero-question completion is allowed when the request and existing choices or explicit delegation resolve stakeholder decisions, and no material contradiction requires clarification. Current implementation alone does not establish product intent or an undelegated major technical choice.

## How to grill

Use the question methods in `references/how-to-grill.md` as tactics for resolving coverage gaps:

1. **Discovery Questions**
2. **Clarification Questions**
3. **Choice Questions**
4. **Example Questions**
5. **Counterexample Questions**
6. **Boundary Questions**
7. **Failure and Exception Questions**
8. **Priority Questions**
9. **Consistency Questions**
10. **Confirmation Questions**
11. **Completion Questions**

These methods are not a checklist that must each produce a question. Coverage state determines whether more questions are required.

## When to reach for it

Use `/grill-with-docs` when you need to stress-test a plan or design and want the resulting terminology or decision to be written down as soon as it settles.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. 계약 갱신·seal은 [sync-contracts](../../delivery/sync-contracts/GUIDE.md)에 따라 최종 구현 workflow만 수행하며 이 단계는 계약을 수정하지 않는다.
