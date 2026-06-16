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
- The dedicated agent must not modify code, settings, skill files, agent files, requirements documents, or `context.md`.
- The dedicated agent may only write to `docs/design/유스케이스.md` and `docs/use-cases/<UC-ID>/` slice documents.

```text
You are the harness use case documentation agent.

Write or update docs/design/유스케이스.md and matching runtime slice docs under docs/use-cases/<UC-ID>/ based on context.md, docs/design/요구사항.md, and any confirmed decision record.

Owned files:
- docs/design/유스케이스.md
- docs/use-cases/<UC-ID>/use-case.md
- docs/use-cases/<UC-ID>/e2e-goal.md

Rules:
- Do not modify code, settings, skill files, agent files, requirements documents, or context.md.
- Do not revert existing user changes.
- Read context.md first.
- Read docs/design/요구사항.md after context.md.
- If context.md is missing or lacks Ubiquitous Language, stop and ask the user to run $harness-requirements first.
- If docs/design/요구사항.md is missing, stop and ask the user to run $harness-requirements first.
- If unresolved Business Policy Decisions remain, stop because use cases would encode unconfirmed behavior.
- If Blocking Open Language Questions block actor, goal, command, input, output, result, policy, or scope-boundary naming, stop because use cases would encode unconfirmed language.
- Use context.md canonical terms and avoid Forbidden Terms.
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
   Read `context.md` first. Confirm that the Ubiquitous Language table exists and that required actor/goal/domain terms are present.

2. **Inspect requirements**
   Read `docs/design/요구사항.md` and any explicit user-provided decision record.

3. **Check readiness**
   Stop if requirements are missing, `context.md` is missing, unresolved business policy decisions remain, or open language questions block use-case naming.
   Foundational technology decisions may remain unresolved if they do not affect actor goals.

4. **Derive actor goals**
   Extract external actors and one goal per actor from confirmed functional requirements, using only canonical terms from `context.md`.

5. **Assign stable use case IDs**
   Assign IDs in `UC-001` format. Preserve existing IDs when updating an existing `docs/design/유스케이스.md`.

6. **Write canonical use cases**
   Write or update `docs/design/유스케이스.md`, using one external actor goal per use case and the canonical language from `context.md`.
   The high-level list must contain parseable bullet entries in the form `- UC-001. <Actor performs goal>`.
   The detailed section for each use case must contain a parseable heading in the form `## UC-001. <Actor performs goal>`.

7. **Write runtime slice docs**
   For every canonical use case, write or update:
   - `docs/use-cases/<UC-ID>/use-case.md`
   - `docs/use-cases/<UC-ID>/e2e-goal.md`
   If runtime metadata includes `target_uc` or `uc_id`, write or update only that matching runtime slice while keeping `docs/design/유스케이스.md` coherent and preserving other slice directories.

8. **Confirm completion**
   If any use case still has multiple goals, mixed command/policy wording, multi-meaning event-storming candidates, non-canonical language, or Forbidden Terms, mark it as `Needs confirmation`.
   If ambiguity blocks correctness, write or update the current use-case draft before asking questions, then ask up to three focused Grill-Me questions and include `Recommended answer:` for each.

