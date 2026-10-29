<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [domain-modeling](../domain-modeling/GUIDE.md) · [implementation-guidance](../implementation-guidance/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md) · [testing-guidance](../testing-guidance/GUIDE.md).

# grill-with-docs

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../static-caller/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`grill-with-docs` runs a coverage-driven interview one decision at a time. It offers a recommended answer, waits for the user's response, and keeps vocabulary and durable decisions current.

It incorporates the question selection and interaction contract of [grilling](../../../.agents/skills/grilling/SKILL.md) and the documentation responsibilities of `domain-modeling`. The interview loop below applies that shared question policy to documented coverage.

## Required preparation

Before asking the first question:

1. MUST read `references/how-to-grill.md`.
2. MUST receive or derive a coverage checklist from the calling skill.
3. MUST respect the calling skill's evidence and inspection boundaries. This skill does not grant access to sources that the caller prohibits.
4. Classify every coverage topic as one of:
   - `SETTLED`: explicitly settled by authoritative input or evidence.
   - `PARTIAL`: some required information is known, but a material gap remains.
   - `UNRESOLVED`: a material decision or required behavior is not settled.
   - `NOT_APPLICABLE`: the topic does not apply, with a concrete reason.
5. Distinguish descriptive facts from stakeholder decisions.

Within the evidence allowed by the calling skill, repository evidence, existing code, tests, specs, ADRs, and project documents may settle descriptive facts and ordinary implementation details. They MUST NOT by themselves settle product intent, desired future behavior, scope, business invariants, user-visible failure behavior, or an important technology, architecture, or data-transfer protocol choice. Honor the user's explicit delegation of such a choice; record the basis as delegated and do not claim the user supplied a rationale they did not give.

## Interview loop

Select questions using the shared [grilling](../../../.agents/skills/grilling/SKILL.md) criteria. Use repository evidence and settled decisions to resolve implementation details, and record engineering rationale without presenting it as a user's decision.

While any stakeholder decision is `PARTIAL` or `UNRESOLVED`:

1. Select the highest-impact unresolved decision.
2. Ask exactly one focused question.
3. Include a recommended answer and a concise reason for the recommendation.
4. Wait for the user's response before moving to another question.
5. Classify the response before updating coverage. A response is not automatically a decision.
   - `ACCEPTED`: the user explicitly chooses, confirms, or clearly authorizes one answer.
   - `REJECTED`: the user clearly rejects the recommendation or the current alternatives without settling a replacement.
   - `QUESTION_OR_CHALLENGE`: the user asks a follow-up question, disputes an assumption, requests more context, or points out a concern.
   - `ALTERNATIVE_PROPOSAL`: the user suggests another option, condition, exception, or trade-off but does not explicitly confirm it as the final rule.
6. Answer or investigate `QUESTION_OR_CHALLENGE` and `ALTERNATIVE_PROPOSAL`. Ask again only if a material stakeholder choice remains unresolved; if the response settles or explicitly delegates it, continue accordingly. Do not infer acceptance from a question or an unconfirmed alternative.
7. Treat `REJECTED` as unresolved unless the user also explicitly settles a replacement. Ask a focused follow-up that resolves the remaining choice.
8. `ACCEPTED`, an unambiguous answer, or explicit delegation may settle the stakeholder decision including its material conditions and exceptions. Resolve delegated and ordinary engineering details from evidence and the approved scope; identify their author and rationale accurately.
9. Reassess affected existing terms as model meaning/ownership/lifecycle settles, not only newly coined terms. Read the [proactive language review](../domain-modeling/references/language-lifecycle.md). Propose implied definition/rename/retirement changes yourself; resolve material meaning choices in this same interview. Once the model decision settles the naming consequence, update it without an extra standalone rename-approval round. Classify the resulting terms using the durable-vocabulary placement rules.
10. Update `CONTEXT.md` for project-wide or explicitly context-scoped canonical terms; update `CONTEXT-MAP.md` for settled bounded-context names, responsibilities, or relationships. Keep Spec-only wording ticket-scoped.
11. When the user explicitly gives a reusable implementation preference, record it through `implementation-guidance` in `<shared_guidance_root>/docs/agents/implementation-guidance.md`, with scope and provenance. Use the original project root supplied by the caller (or the current project root outside a managed worktree); never update a worktree-local copy. Do not record inferred preferences or product/architecture decisions there.
12. When the user explicitly gives a reusable test-running preference, record it through `testing-guidance` in `<shared_guidance_root>/docs/agents/testing-guidance.md`; use the same canonical-root rule.
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

If an ambiguity changes a material stakeholder decision and cannot be resolved from the user's existing instructions, ask a clarification. Resolve nonmaterial implementation details using project evidence and reasonable judgment. Do not treat silence as consent.

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

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.
