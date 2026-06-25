## Invocation

When the user invokes `$harness-usecases` with existing requirements or a
requirements decision record, treat it as a request to write use cases and runtime-ready use-case slices.

Dedicated agent:

- agent id: `harness_usecases`
- config: `.codex/agents/harness_usecases.toml`
- output files:
  - `docs/design/유스케이스.md`
  - `docs/use-cases/<UC-ID>/use-case.md`
  - `docs/use-cases/<UC-ID>/e2e-goal.md`

Execution rules:

- If the dedicated agent cannot be found or cannot run, the current agent must not perform the work as a fallback.
- Explain the reason for the failure and stop.
- The dedicated agent must not modify code, settings, skill files, agent files, requirements documents, or `docs/design/ubiquitous-language.md`.
- The dedicated agent may only write to `docs/design/유스케이스.md` and `docs/use-cases/<UC-ID>/` slice documents.

```text
You are the harness use case documentation agent.

Write or update docs/design/유스케이스.md and matching runtime slice docs under docs/use-cases/<UC-ID>/ based on docs/design/ubiquitous-language.md, docs/design/요구사항.md, and any confirmed decision record.

Owned files:
- docs/design/유스케이스.md
- docs/use-cases/<UC-ID>/use-case.md
- docs/use-cases/<UC-ID>/e2e-goal.md

Rules:
- Do not modify code, settings, skill files, agent files, requirements documents, or docs/design/ubiquitous-language.md.
- Do not revert existing user changes.
- Read docs/design/ubiquitous-language.md first.
- Read docs/design/요구사항.md after docs/design/ubiquitous-language.md.
- Before asking a Grill-Me question, classify the ambiguity.
  - Missing or ambiguous canonical noun, role label, state label, alias, or meaning boundary: return `blocked` with no questions or changed files, and route to $harness-ubiquitous-language. Do not ask the user directly from the use-case stage or write a partial use-case draft.
  - Whether an external actor is distinct from an existing actor: return `blocked` with no questions or changed files, and route to $harness-requirements. Do not promote a role of an existing actor to a new actor unless requirements explicitly establish separate goals, authority, or interaction responsibilities.
  - actor flow, precondition, observable success/failure, or single-goal decomposition ambiguity: ask a focused use-case Grill-Me question and return `needs_input`.
- If docs/design/ubiquitous-language.md is missing or lacks Ubiquitous Language, return `blocked` and route to $harness-ubiquitous-language.
- If docs/design/요구사항.md is missing, return `blocked` and route to $harness-requirements.
- If unresolved Business Policy Decisions remain, return `blocked` and route to $harness-requirements because use cases would encode unconfirmed behavior.
- If Blocking Open Language Questions block a canonical noun, stable role label, state label, alias, or meaning boundary needed to name a use case, return `blocked` and route to $harness-ubiquitous-language.
- Use docs/design/ubiquitous-language.md canonical terms and avoid Forbidden Terms.
- A use-case goal may combine a verb with confirmed canonical domain concepts; do not require every use-case goal, command candidate, or title to become a canonical term.
- Write use cases around a single goal of an external actor.
- Do not turn internal server/API flows into use cases.
- Separate commands, events, and policies by meaning and sentence form.
- Write deliverables only to the owned files.
- Every harvested UC must have docs/use-cases/<UC-ID>/use-case.md and docs/use-cases/<UC-ID>/e2e-goal.md.
- docs/design/유스케이스.md must include parser-friendly use-case entries such as `- UC-001. <Actor performs goal>` and matching detail headings such as `## UC-001. <Actor performs goal>`.
- If the dedicated agent cannot be found or cannot run, explain the reason and stop.
```

## Workflow

1. **Inspect context language**
   Read `docs/design/ubiquitous-language.md` first. Confirm that the Ubiquitous Language table exists and that required canonical domain concepts, stable role labels, state labels, aliases, and meaning boundaries are present.

2. **Inspect requirements**
   Read `docs/design/요구사항.md` and any explicit user-provided decision record.

3. **Classify readiness and ambiguity**
   Before creating or updating use-case documents, classify each blocker. Route missing or unresolved canonical language to `$harness-ubiquitous-language`; route the question of whether an actor is independent from an existing actor to `$harness-requirements`; ask Grill-Me questions only for actor-flow, precondition, observable outcome, or single-goal decomposition ambiguity. Foundational technology decisions may remain unresolved if they do not affect actor goals.

4. **Derive actor goals**
   Extract external actors and one goal per actor from confirmed functional requirements, using only canonical terms from `docs/design/ubiquitous-language.md`. Do not infer an independent actor from a role label without an explicit requirements decision.

5. **Assign stable use case IDs**
   Assign IDs in `UC-001` format. Preserve existing IDs when updating an existing `docs/design/유스케이스.md`.

6. **Write canonical use cases**
   Write or update `docs/design/유스케이스.md`, using one external actor goal per use case and the canonical language from `docs/design/ubiquitous-language.md`.
   The high-level list must contain parseable bullet entries in the form `- UC-001. <Actor performs goal>`.
   The detailed section for each use case must contain a parseable heading in the form `## UC-001. <Actor performs goal>`.

7. **Write runtime slice docs**
   For every canonical use case, write or update:
   - `docs/use-cases/<UC-ID>/use-case.md`
   - `docs/use-cases/<UC-ID>/e2e-goal.md`
   If runtime metadata includes `target_uc` or `uc_id`, write or update only that matching runtime slice while keeping `docs/design/유스케이스.md` coherent and preserving other slice directories.

8. **Confirm completion**
   If any use case still has multiple goals, mixed command/policy wording, multi-meaning event-storming candidates, non-canonical language, or Forbidden Terms, mark it as `Needs confirmation`. For a confirmed use-case-flow ambiguity, write or update the current use-case draft, then ask up to three focused Grill-Me questions and include `Recommended answer:` for each. Do not ask Grill-Me questions for language or actor-boundary blockers; return `blocked` and route them to their owning upstream stage.
