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

Ubiquitous-language-definition owns:
- canonical term
- Korean label
- English/code-facing label
- aliases
- forbidden terms
- meaning boundary
- use-case-facing command, input, output, result, policy, and scope-boundary terminology

Do not ask broad requirements questions unless a contradiction blocks language confirmation. If blocked, report an upstream requirements blocker and stop.

## Deferred Naming

Do not ask aggregate naming, domain event naming, or state-transition naming questions during this stage. Record those as deferred DDD or event-storming questions if they appear.

## Question Loop

- Write or update the current `context.md` draft before asking questions.
- Ask up to three focused Grill-Me questions per turn.
- Ask only language blockers needed before the ubiquitous language stage can be correct.
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
