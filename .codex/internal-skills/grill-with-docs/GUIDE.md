<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [domain-modeling](../domain-modeling/GUIDE.md) · [implementation-guidance](../implementation-guidance/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md) · [testing-guidance](../testing-guidance/GUIDE.md).

# grill-with-docs

## What it does

`grill-with-docs` runs a coverage-driven interview. For `spec-me`, it batches independent decisions; other callers use one decision at a time. It offers recommended answers and keeps vocabulary and durable decisions current.

It incorporates the question selection and interaction contract of [grilling](../../../.codex/internal-skills/grilling/GUIDE.md) and the documentation responsibilities of `domain-modeling`. The interview loop below applies that shared question policy to documented coverage.

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

Select questions using the shared [grilling](../../../.codex/internal-skills/grilling/GUIDE.md) criteria. Use repository evidence and settled decisions to resolve implementation details, and record engineering rationale without presenting it as a user's decision.

While a decision necessary for the requested core behavior is materially `PARTIAL` or `UNRESOLVED` and cannot be resolved from existing evidence or a reasonable default:

1. For `spec-me`, inspect every applicable coverage topic and gather all currently identifiable material decisions before returning any questions. Reuse settled answers and explicit delegation. Identify dependencies between decisions; put every independently answerable decision into one `questions` array, including relevant scope, behavior, failures and acceptance conditions. Do not stop gathering at the first gap. Ask dependent follow-ups only after their prerequisite answers make them meaningful. A single question is valid when it is the only currently answerable material decision. For other callers, select the highest-impact unresolved decision and ask one focused question.
2. Make each question focused and independently answerable; include a recommended answer and a concise reason for it.
3. Wait for the user's responses to the batch before proceeding. Classify each response separately and reassess the full coverage checklist before the next batch.
5. Classify the response before updating coverage. A response is not automatically a decision.
   - `ACCEPTED`: the user explicitly chooses, confirms, or clearly authorizes one answer.
   - `REJECTED`: the user clearly rejects the recommendation or the current alternatives without settling a replacement.
   - `QUESTION_OR_CHALLENGE`: the user asks a follow-up question, disputes an assumption, requests more context, or points out a concern.
   - `ALTERNATIVE_PROPOSAL`: the user suggests another option, condition, exception, or trade-off but does not explicitly confirm it as the final rule.
6. Answer or investigate `QUESTION_OR_CHALLENGE` and `ALTERNATIVE_PROPOSAL`. Ask again only if a material stakeholder choice remains unresolved; if the response settles or explicitly delegates it, continue accordingly. Do not infer acceptance from a question or an unconfirmed alternative.
7. Treat `REJECTED` as unresolved unless the user also explicitly settles a replacement. Ask a focused follow-up that resolves the remaining choice.
8. `ACCEPTED`, an unambiguous answer, or explicit delegation may settle the stakeholder decision including its material conditions and exceptions. Resolve delegated and ordinary engineering details from evidence and the approved scope; identify their author and rationale accurately.
9. Reassess affected existing terms as model meaning/ownership/lifecycle settles, not only newly coined terms. Read the [proactive language review](../domain-modeling/references/language-lifecycle.md). Propose implied definition/rename/retirement changes yourself; resolve material meaning choices in this same interview. Once the model decision settles the naming consequence, update it without an extra standalone rename-approval round. Classify the resulting terms using the durable-vocabulary placement rules.
10. Update the consumer project's shared `CONTEXT.md` for every agreed domain term defined in Product Spec section 4 and every Architecture-stage term or definition change. Update `CONTEXT-MAP.md` for settled bounded-context names, responsibilities, or relationships. Keep non-domain explanatory wording ticket-scoped.
11. When the user explicitly gives a reusable implementation preference, record it through `implementation-guidance` in `<workspace_root>/docs/agents/implementation-guidance.md`, with scope and provenance. Use the active workflow workspace so the memory update is part of its branch. Do not record developer/skill instructions, inferred preferences, or product/architecture decisions there.
12. When the user explicitly gives a reusable test-running preference, record it through `testing-guidance` in `<workspace_root>/docs/agents/testing-guidance.md`.
13. Record a durable, expensive-to-reverse decision in an ADR when it is worth preserving, but only after the decision is settled.
14. Repeat until no material stakeholder decision remains unresolved. Complete ordinary engineering details without turning each one into an interview question.

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
- Durable vocabulary and bounded-context updates required by settled decisions are reflected in `CONTEXT.md` and/or `CONTEXT-MAP.md` before completion.
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

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. 계약 갱신·seal은 [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md)에 따라 최종 구현 workflow만 수행하며 이 단계는 계약을 수정하지 않는다.
