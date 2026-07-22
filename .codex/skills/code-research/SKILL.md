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
