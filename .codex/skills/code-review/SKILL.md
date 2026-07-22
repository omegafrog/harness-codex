---
name: code-review
description: Review the diff between HEAD and a fixed point with independent Standards and Spec subagents.
---

# code-review

## What it does

`code-review` reviews the diff between `HEAD` and a fixed point the caller supplies. It runs two independent, read-only subagents and keeps their findings separate:

- Standards: does the code follow this repo's documented conventions and the local code-review principles?
- Spec: does the diff match what the originating issue or spec asked for?

The review only makes sense when there is a fixed point and a diff to judge.

## Standards

Standards checks whether the code is implemented according to the project’s rules and the local default rules:

- Read `.codex/repository-conventions.md` if it exists.
- If that file is absent, read `references/default-rules.md` instead.

Standards also checks the repo’s documented conventions, Repository Architecture Policy, related ADR, naming, structure, and code smell.
If there is no executable code in scope, treat automated-test-based evaluation as not applicable.

## Spec

Spec checks the diff against the originating spec artifact and asks:

- what the spec asked for that is missing or partial
- what the diff added that the spec did not ask for
- what looks implemented but appears wrong relative to the spec

If there is no spec artifact, the Spec axis skips and reports that no spec is available.

## Inputs

- fixed point ref
- diff between `HEAD` and the fixed point
- commit list
- repository standards or architecture policy
- originating spec or issue reference, if available

## Process

1. Confirm the fixed point first.
2. Spawn the Standards review subagent with the lightweight model unless the caller names a supported model.
3. Spawn the Spec review subagent with the lightweight model unless the caller names a supported model.
4. Run them in parallel when the harness supports it; otherwise keep them independent and read-only.
5. Keep the two subagent contexts isolated.
6. Aggregate the two reports without merging or reranking them.

## Rules

- Do not auto-fix.
- Do not auto-rerun.
- Do not auto-close issues.
- Do not merge Standards and Spec into one verdict.
- Do not let one axis mask the other.
- If subagent isolation is unavailable, report that limitation instead of pretending it ran normally.
- Treat a caller-specified model as higher priority than the lightweight default.

## Output

- fixed point
- Standards findings
- Spec findings
- per-axis summary
- unresolved blockers
