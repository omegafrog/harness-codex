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
5. Update the coverage state from the answer.
6. Record new or corrected ubiquitous language through the domain-modeling responsibility.
7. Record a durable, expensive-to-reverse decision in an ADR when it is worth preserving.
8. Repeat until no material `PARTIAL` or `UNRESOLVED` topic remains.

Do not ask questions merely to increase question count. Prefer questions that expose assumptions, boundaries, counterexamples, failures, conflicts, and trade-offs.

## Completion gate

The interview MAY finish only when all of the following are true:

- Every required coverage topic is `SETTLED` or `NOT_APPLICABLE`.
- No material stakeholder decision is based only on model inference.
- No material contradiction remains between user answers, specs, ADRs, allowed evidence, or earlier decisions.
- Blocking open questions are resolved.
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
