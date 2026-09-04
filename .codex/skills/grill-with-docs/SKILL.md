---
name: grill-with-docs
description: Interview a design one decision at a time while updating project vocabulary and durable decisions. Use when a design discussion should update CONTEXT.md or ADRs.
---

# grill-with-docs

## What it does

`grill-with-docs` runs a coverage-driven interview one decision at a time. It offers a recommended answer, waits for the user's response, and keeps vocabulary and durable decisions current.

It incorporates the interaction contract of `grilling` and the documentation responsibilities of `domain-modeling`. Do not treat those as optional background descriptions: the interview loop below is the execution contract for this skill.

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

Within the evidence allowed by the calling skill, repository evidence, existing code, tests, specs, ADRs, and project documents may settle descriptive facts. They MUST NOT be treated as settling product intent, desired future behavior, scope, trade-offs, exceptions, business invariants, user-visible failure behavior, or a target architecture choice when multiple valid futures remain.

## Interview loop

While any material topic is `PARTIAL` or `UNRESOLVED`:

1. Select the highest-impact unresolved decision.
2. Ask exactly one focused question.
3. Include a recommended answer and a concise reason for the recommendation.
4. Wait for the user's response before moving to another question.
5. Classify the response before updating coverage. A response is not automatically a decision.
   - `ACCEPTED`: the user explicitly chooses, confirms, or clearly authorizes one answer.
   - `REJECTED`: the user clearly rejects the recommendation or the current alternatives without settling a replacement.
   - `QUESTION_OR_CHALLENGE`: the user asks a follow-up question, disputes an assumption, requests more context, or points out a concern.
   - `ALTERNATIVE_PROPOSAL`: the user suggests another option, condition, exception, or trade-off but does not explicitly confirm it as the final rule.
6. Treat `QUESTION_OR_CHALLENGE` and `ALTERNATIVE_PROPOSAL` as unresolved. Answer or investigate the user's point, then ask the same decision question again (possibly refined). Do not mark coverage `SETTLED`, record a final decision, or move to the next topic.
7. Treat `REJECTED` as unresolved unless the user also explicitly settles a replacement. Ask a focused follow-up that resolves the remaining choice.
8. Only `ACCEPTED`, or an unambiguous answer that settles the complete decision including material conditions and exceptions, may update the coverage state to `SETTLED`.
9. Classify every newly settled term using the domain-modeling durable-vocabulary placement rules.
10. Update `CONTEXT.md` for project-wide or explicitly context-scoped canonical terms; update `CONTEXT-MAP.md` for settled bounded-context names, responsibilities, or relationships. Keep Spec-only wording ticket-scoped.
11. Record a durable, expensive-to-reverse decision in an ADR when it is worth preserving, but only after the decision is settled.
12. Repeat until no material `PARTIAL` or `UNRESOLVED` topic remains.

### Response confirmation gate

Never infer consent from conversational momentum. In particular, do not interpret “what about...?”, “could we instead...?”, “I suggest...”, “why not...?”, or a conditional statement as acceptance of the recommended answer.

When the user responds with a question or proposal:

1. Answer the question or acknowledge the proposal and explain its implications.
2. State the currently pending decision in one sentence.
3. Ask for explicit confirmation or a concrete choice. Keep the interview on this topic.

Example:

> User: What if administrators need to bypass this limit?
>
> Agent: That would make the limit apply to regular users only, with an administrator exception. The pending decision is whether the limit is universal or bypassable by administrators. Should I record the administrator exception?

If the user's wording remains ambiguous, ask a clarification or confirmation question instead of choosing the most plausible interpretation. Do not advance merely because the user answered the previous message, offered a seemingly compatible suggestion, or stopped objecting.

Do not ask questions merely to increase question count. Prefer questions that expose assumptions, boundaries, counterexamples, failures, conflicts, and trade-offs.

## Completion gate

The interview MAY finish only when all of the following are true:

- Every required coverage topic is `SETTLED` or `NOT_APPLICABLE`.
- No material stakeholder decision is based only on model inference.
- No material contradiction remains between user answers, specs, ADRs, allowed evidence, or earlier decisions.
- Blocking open questions are resolved.
- Durable vocabulary and bounded-context updates required by settled decisions are reflected in `CONTEXT.md` and/or `CONTEXT-MAP.md` before completion.
- A Completion Question from `references/how-to-grill.md` has been asked and answered, unless zero-question completion is allowed below.

Zero-question completion is exceptional. It is allowed only when every required topic is already explicitly settled by authoritative input, no material stakeholder decision remains, and no contradiction or ambiguity requires confirmation. Do not use current implementation alone as justification for zero-question completion.

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
