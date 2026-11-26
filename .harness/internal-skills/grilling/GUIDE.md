---
model_tier: high_performance
---

# grilling

## What it does

`grilling` stress-tests a plan or design one decision at a time.

It asks one question at a time, includes a recommended answer, and waits for the response before moving on. It does not ask for facts the codebase or documents can already settle.

Ask about unresolved business rules and consequential technology, architecture, integration, or data-transfer protocol choices. Resolve routine implementation and codebase details from the repository and settled decisions; ask only if a material user-visible consequence, compatibility constraint, irreversible effect, or unresolved conflict requires the user's choice. Honor explicit delegation and do not repeatedly ask the user to defend a delegated implementation choice.

## Decide whether to ask

One criterion for every stage that may ask; the stage GUIDEs refer to it and never restate it. Judge each open decision by its outcome for the user or the business:

- **ASK (`impact: high`)**: plausible choices give a different user or business outcome AND the choice is what the requested feature fundamentally does, or is hard or costly to undo: data source, ownership, retention or deletion; permission or visibility; an external dependency; money or cost; an irreversible action (send, delete, charge); whether a failed delivery or action is retried or dropped; a rule or number that decides who or what is affected.
- **DEFAULT (`impact: low`)**: the outcome differs but is cheap to change later (wording, loading or empty presentation, ordering, layout). Decide it, mark the source `요청 해석(에이전트 제안)` and list it for the user's approval. Never ask it.
- **DECIDE SILENTLY**: no observable difference.
- Decision test, applied per decision: if the user later picked the other option, what must be undone or redone? Only a display or timing setting: `low`. Messages already sent to other people, data kept or deleted, money, who is affected, an external system: `high`.
- When unsure: `high` only if the decision touches permission or visibility, an external dependency, money, an irreversible action, data retention or deletion, retry or drop of a failed delivery or action, or who or what is affected; for everything else unsure is `low`.
- One decision is one gap and at most one question; never split it into several.
- Counter-examples. Monthly settlement report: rounding of displayed amounts is `low`, which accounts are included is `high`. Signup confirmation mail: wording and send delay are `low`, whether to send to unverified addresses is `high`.

The recommended option is the smallest option among those that serve the purpose of the request as a user of such a feature would expect, and its rationale names that purpose. The smallest option alone is not a reason.

## Ask questions the user can answer

Treat each question as if the user has not followed the agent's private reasoning. State the decision being made and the relevant situation in plain language; do not rely on unexplained project terms, prior turns, or findings the user has not seen. Briefly explain why the decision matters and what choosing an option would change. Expand a question when needed for clarity, while keeping it about one decision.

Name concrete options and their practical consequences. Include a recommended option and a short reason for the recommendation. Avoid cryptic shorthand, unexplained labels, and options that differ only in wording. If a term is necessary, define it in the question.

Give every question its context and every option a worked example. State the business rules already settled that bear on the decision (quote the settled document or answer, never add one) and why it must be decided now. For each option say what changes on screen or in behavior, and play the same concrete situation out under it so the options compare side by side. Example (an expiry notice): when an approval lapses, notify the requester only, or the requester and the approver's manager; same lapse, different recipients. Example (a monthly settlement): a correction after closing changes the closed month, or is booked into the next month. An example illustrates the choice and is never recorded as a requirement. A stage returns these as `context`, `effect` and `example`, and a question without them is rejected. Keep it short: at most 3 settled rules, and one line (160 characters) for `why_now` and for each `effect` and `example`; a longer one is rejected. When one batch asks several questions, an option that cannot hold with an option of another question lists it in `excludes`; ask a question that only makes sense under one answer of another after that answer.

For example, instead of asking “Keep the snapshot or regenerate it?”, explain what the snapshot records, why it may be stale, and what each choice means for this change.

## When to reach for it

Use `/grilling` when you want to pressure-test a plan, design, or idea before building it.


In a stage execution, return questions as the stage return contract defines instead of asking interactively.
