## Embedded Standards

Use the following standards as the source of truth for the instructions.

### Ubiquitous Language Standards

- Read `context.md` before writing or updating use cases.
- Treat `context.md` as the project-wide source of truth for domain language.
- Use only the canonical terms defined in the `Ubiquitous Language` table.
- Use the table's `English` names for code-facing command/event/policy candidates when such candidates are included.
- Do not introduce new actor names, goal names, domain concepts, state names, command names, event names, policy names, or external system names that conflict with `context.md`.
- Do not use terms listed under `Forbidden Terms`.
- If a needed MVP term is missing or ambiguous, stop or mark the related use case detail as `Needs confirmation`; record the missing term as a `Blocking Open Language Question` instead of inventing behavior.

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
- If a requirement is ambiguous, mark the related use case detail as `Needs confirmation` instead of inventing behavior.

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
- If the use case is not fully confirmed, still create both slice documents and mark ambiguous sections as `Needs confirmation`.
- Do not leave a harvested use case only in `docs/design/유스케이스.md`; it must have matching runtime slice documents.

