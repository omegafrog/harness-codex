---
name: code-research
description: Inspect a codebase and return a compact architecture-focused summary. Use before architecture design, refactoring decisions, or implementation planning.
---

# code-research

## What it does

`code-research` inspects the current codebase and returns only the facts and deltas needed for architecture work.

## What it collects

- current package and module structure
- public entrypoints and boundaries
- relevant source and test seams
- persistence, adapter, and integration touchpoints
- anything that conflicts with the target design

For DDD/architecture work, read the affected `CONTEXT-MAP.md`, linked ADRs/models/diagrams, and `docs/architecture/domain-model.md` when present. Return the affected existing contexts, aggregate roots or explicit absence, identity/state/invariants, rule-owning methods/functions, public APIs, callers, data/transaction ownership, communication paths, and deployment units with source `file:line` and inspected commit. Separate observed implementation, accepted target, and document drift. Identify the smallest existing-owner extension and missing evidence; do not infer new aggregates from directory names. See [model continuity](../ddd-design/references/model-continuity.md).

## Navigation policy

Check current scoped canonical/retired terms before naming the model. For replacement work, identify old entrypoints and all affected static/dynamic consumers, exports, configuration, installed paths, fixtures and current documentation; return the migration/removal scope and evidenced compatibility exceptions. Historical names alone do not authorize new aliases. Use the language lifecycle and replacement rules linked from model continuity.

Report evidence when current glossary meaning diverges from observed model responsibility/lifecycle, or synonyms/overloaded names obscure ownership, even if no term is already marked retired. Return facts and affected terms to the design parent; the researcher does not choose future business meaning or approve a rename.

- When the Graphify navigation connector is available, use it first to locate relevant modules, symbols, and dependency edges.
- Treat Graphify as a navigation index only; verify every concrete claim against the actual source and tests.
- Supplement incomplete or unavailable Graphify results with repository-local `rg`/`find` searches.
- Do not create or persist a separate repository map, cache, or derived source index for this workflow.

## Agent execution

Run the research in one subagent instead of inspecting the whole codebase inline.

- Use `multi_agent_v1.spawn_agent` with the `code_researcher` agent profile when available.
- Resolve `.codex/harness.yaml` `agents.low_performance_model` to an actual model ID and pass it explicitly to `multi_agent_v1.spawn_agent`. Fall back to `agents.default_model` only for older configurations.
- If no model resolves, stop and require `setup`; never omit the override or inherit the parent model. The `code_researcher` profile owns its fixed `medium` reasoning effort.
- A user-specified supported model for the current request overrides both defaults.
- Keep reasoning effort modest unless the user explicitly requests deeper reasoning.
- Use `fork_context: false`.
- Keep the main agent responsible for reading the result, checking it against the current request, and deciding what to pass into the next skill.

Use this prompt for the subagent:

```text
You are the code-research subagent.

Work in the current repository. Inspect only the code and tests needed to answer the research request. Do not edit files. Do not make product or architecture decisions.

Return a compact architecture-focused report with these sections:

1. Current Structure
2. Entry Points And Boundaries
3. Relevant Source And Test Seams
4. Persistence, Adapter, And Integration Touchpoints
5. Mismatches Against Target Design
6. Structural Risks
7. Follow-up Areas For codebase-design

For every concrete claim, include file paths. Keep the report short and factual.
```

## What it leaves out

- implementation drafting
- redesign decisions
- long narrative explanations
- anything that is already obvious from the target design

## Output

- a short codebase summary
- a list of mismatches against the target design
- a list of structural risks
- a list of files or areas that need follow-up in `codebase-design`

실행 전제에 영향이 있는 조사에서는 실제 entrypoint/config loader/compose·infra/CI를 `docs/agents/execution.json`과 EXEC에 대조하여 필수 인자·설정 갱신·인프라 누락을 보고한다. 빈 dependency/prepare 목록을 무조건 신뢰하지 않는다.
