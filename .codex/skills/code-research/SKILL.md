---
name: code-research
description: Inspect a codebase and return a compact architecture-focused summary. Use before architecture design, refactoring decisions, or implementation planning.
---

# code-research

## What it does

`code-research` inspects the current codebase and returns a compact summary for architecture work. It is intentionally narrow: collect the facts the design needs, leave out the rest, and hand back only the deltas that matter.

## What it collects

- current package and module structure
- public entrypoints and boundaries
- relevant source and test seams
- persistence, adapter, and integration touchpoints
- anything that conflicts with the target design

## Agent execution

Run the research in one subagent instead of inspecting the whole codebase inline.

- Use `multi_agent_v1.spawn_agent`.
- Use the model in `.codex/harness.yaml` at `agents.default_model` when present.
- If no default model is configured, use the lightest available model in the current Codex runtime.
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

## Pulled out on purpose

`code-research` exists so the architecture flow can spend context on decisions instead of reading the whole codebase inline.
