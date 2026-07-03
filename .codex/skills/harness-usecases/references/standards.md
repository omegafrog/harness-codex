## Embedded Standards

Use the following standards as the source of truth for the instructions.

### Ubiquitous Language Standards

- Read `docs/design/ubiquitous-language.md` before writing or updating use cases.
- Treat `docs/design/ubiquitous-language.md` as the project-wide source of truth for domain language.
- Use only the canonical terms defined in the `Ubiquitous Language` table.
- Use the table's `English` names for code-facing command/event/policy candidates when such candidates are included.
- Do not introduce new actor names, goal names, domain concepts, state names, command names, event names, policy names, or external system names that conflict with `docs/design/ubiquitous-language.md`.
- Do not use terms listed under `Forbidden Terms`.
- If a canonical noun, role label, state label, alias, or meaning boundary needed to name a use case is missing or ambiguous, return `blocked` and route to `$harness-ubiquitous-language` instead of writing or updating use-case documents.

### Ambiguity Routing Standards

Before reporting a blocker, classify the ambiguity.

- Missing or ambiguous canonical noun, role label, state label, alias, or meaning boundary: return `blocked` and route to `$harness-ubiquitous-language`. Do not ask the user directly from the use-case stage, write a partial use-case draft, or invent the missing language.
- Whether an external actor is distinct from an existing actor: return `blocked` and route to `$harness-requirements`. Do not promote a role of an existing actor to a new actor unless requirements explicitly establish separate goals, authority, or interaction responsibilities.
- actor flow, precondition, observable success/failure, or single-goal decomposition ambiguity: resolve it inside the use-case stage by choosing the most conservative actor-visible behavior or observable constraint supported by requirements and ubiquitous language. Return `blocked` only when the upstream artifacts are contradictory or insufficient even for a conservative use-case decision.
- Do not require every use-case verb, goal, or title to become a canonical term. A use-case goal may combine a verb with confirmed canonical domain concepts. Keep a domain concept, an actor role, a state label, and a use-case action distinct unless `docs/design/ubiquitous-language.md` explicitly confirms the same meaning boundary.

### Use Case Standards

- Write use cases around the goals of external actors.
- Do not define internal server/API interactions as use cases.
- Use case names in this format: `UC-001. Actor performs goal`.
- Each use case must contain exactly one user goal.
- Split combined goals into separate use cases.
- When a detailed flow implies commands, events, or policies, each sentence must have a single meaning.
- Do not mix policies and commands.
- Commands must be imperative.
- Events must be past tense.
- Policies must be written as conditions or decision criteria.
- A use case that does not satisfy these rules is not complete.
- If a use-case detail is ambiguous, do not leave `Needs Confirmation` sections, `Needs confirmation` placeholders, or equivalent unresolved-confirmation headings. Do not treat a confirmed canonical state label such as `확인 필요` as a marker. Choose the most conservative actor-visible behavior or observable constraint supported by requirements and ubiquitous language, update the use-case artifacts, and complete only after no confirmation marker remains.

### Runtime Slice Document Standards

For every harvested use case ID, write a runtime slice directory:

```text
docs/use-cases/<UC-ID>/
  use-case.md
  e2e-goal.md
```

Rules:
- Use stable three-digit UC IDs such as `UC-001`, `UC-002`, and `UC-003`.
- The canonical `docs/design/유스케이스.md` list and every slice directory must use the same UC ID and title.
- `docs/design/유스케이스.md` must include at least one parser-friendly line per use case in either `- UC-001. <Actor performs goal>` or `## UC-001. <Actor performs goal>` form.
- Do not express the only canonical use-case list as a markdown table, bold label, or metadata field.
- `docs/use-cases/<UC-ID>/use-case.md` must contain the detailed use case for exactly one use case.
- `docs/use-cases/<UC-ID>/e2e-goal.md` must define the end-to-end verification goal for that same use case.
- Do not mark ambiguous sections as `Needs Confirmation` or `Needs confirmation`. Resolve use-case ambiguity inside the stage or return `blocked` with the exact upstream contradiction. Do not report readiness until no confirmation marker remains.
- Do not leave a harvested use case only in `docs/design/유스케이스.md`; it must have matching runtime slice documents.
