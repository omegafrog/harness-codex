# harness-ubiquitous-language Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-ubiquitous-language/SKILL.md`
- Agent config: `.codex/agents/ubiquitous_language_reviewer.toml`
- Agent reference: `.codex/agents/references/ubiquitous_language_reviewer.md`

## Role

Confirm project ubiquitous language after requirements are stable and before use-case writing.

## Required Inputs

- `docs/design/요구사항.md`
- Existing `context.md` when present

If `docs/design/요구사항.md` is missing, stop and ask the user to run `$harness-requirements` first.

## Outputs

- `context.md`

Do not edit `docs/design/요구사항.md`. Do not write use cases.

## Stage Boundary

Requirements-definition owns:
- actor
- goal
- user-visible success condition
- user-visible failure policy
- hard scope boundary
- business policy decisions
- only MVP-blocking terms needed to understand the requirement
- whether a role of an existing actor is an independent external actor with separate goals, authority, or interaction responsibilities

Ubiquitous-language-definition owns:
- canonical term
- Korean label
- English/code-facing label
- aliases
- forbidden terms
- meaning boundary
- canonical vocabulary for domain concepts, stable roles, user-visible concepts, and state labels when needed

Do not require every use-case verb, use-case goal, command candidate, or use-case title to become a canonical term. A use-case goal may combine a verb with canonical domain concepts.

Keep the following categories distinct unless requirements and `context.md` explicitly establish the same meaning boundary:
- domain concept
- actor-role label
- state label
- use-case goal or action

For example, a state label must not be confirmed as though it were a use-case action, and a role label must not be treated as a separate external actor without an explicit requirements decision.

Do not ask broad requirements questions unless a contradiction blocks language confirmation. Do not ask whether a domain object, note type, source rule, MVP policy, actor goal, success condition, failure policy, hard scope, or independent external actor belongs in the product. Those decisions belong upstream in requirements. If blocked, report an upstream requirements blocker and stop.

## Deferred Naming

Do not ask aggregate naming, domain event naming, or state-transition naming questions during this stage. Record those as deferred DDD or event-storming questions if they appear.

## Question Loop

- Write or update the current `context.md` draft before asking questions.
- Ask up to three focused Grill-Me questions per turn.
- Ask only language blockers needed before the ubiquitous language stage can be correct.
- Ask about wording only: canonical term, Korean label, English/code-facing label, aliases, forbidden terms, or exact meaning boundary.
- Do not ask product-policy questions such as whether a note must cite an external source; record those as upstream requirements blockers when they prevent language confirmation.
- Run at most 3 rounds.
- Include `Recommended answer:` with every question.
- After each round, summarize what has been clarified and what remains unresolved.
- Do not continue asking until terminology is perfect.
- When invoked by runtime, return only JSON with keys `status`, `questions`, `changed_files`, and `blocker`.

## context.md Contract

Use this structure:

```markdown
# Project Context

## 1. Ubiquitous Language

| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | grill-me |

## 2. Naming Rules

- Documents must use `Canonical Term`.
- Code class, method, package, command, event, and policy identifiers must use `English`.
- User-facing text should use `Korean`.
- `Forbidden Terms` must not be used in new documents, plans, tests, or code identifiers.
- Aliases are recorded only for migration/search context and must not be introduced as new canonical language.

## 3. Blocking Open Language Questions

- None.

## 4. Deferred Language Questions

- None.
```

Use `Source` value `grill-me` for confirmed terms from clarification.
