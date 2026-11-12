---
model_tier: high_performance
---

# grilling

## What it does

`grilling` stress-tests a plan or design one decision at a time.

It asks one question at a time, includes a recommended answer, and waits for the response before moving on. It does not ask for facts the codebase or documents can already settle.

Ask about unresolved business rules and consequential technology, architecture, integration, or data-transfer protocol choices. Resolve routine implementation and codebase details from the repository and settled decisions; ask only if a material user-visible consequence, compatibility constraint, irreversible effect, or unresolved conflict requires the user's choice. Honor explicit delegation and do not repeatedly ask the user to defend a delegated implementation choice.

## Ask questions the user can answer

Treat each question as if the user has not followed the agent's private reasoning. State the decision being made and the relevant situation in plain language; do not rely on unexplained project terms, prior turns, or findings the user has not seen. Briefly explain why the decision matters and what choosing an option would change. Expand a question when needed for clarity, while keeping it about one decision.

Name concrete options and their practical consequences. Include a recommended option and a short reason for the recommendation. Avoid cryptic shorthand, unexplained labels, and options that differ only in wording. If a term is necessary, define it in the question.

For example, instead of asking “Keep the snapshot or regenerate it?”, explain what the snapshot records, why it may be stale, and what each choice means for this change.

## When to reach for it

Use `/grilling` when you want to pressure-test a plan, design, or idea before building it.


In a stage execution, return questions as the stage return contract defines instead of asking interactively.
