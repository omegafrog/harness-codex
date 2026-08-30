---
name: code-review
description: Review the diff between HEAD and a fixed point with independent Standards and Spec subagents.
---

# code-review

## What it does

`code-review` reviews the diff between `HEAD` and a caller-supplied fixed point using two independent, read-only subagents:

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
2. Read `.codex/harness.yaml` and use `agents.default_model` for review subagents when present.
3. If no default model is configured, use the lightest available model in the current Codex runtime.
4. Spawn the `standards_reviewer` profile with only the diff, commit list, and standards sources.
5. Spawn the `spec_reviewer` profile with only the diff, commit list, and spec source.
6. Run them in parallel when the harness supports it; otherwise keep them independent and read-only.
7. Keep the two subagent contexts isolated.
8. Wait long enough for both review subagents to finish before aggregating.
9. Aggregate the two reports without merging or reranking them.

## Waiting

- Use `wait_agent` with a long timeout, preferably 300000 ms or longer when the tool allows it.
- Do not use several short 30000 ms waits as the normal path.
- Treat `timed_out` as "still running", not as a review failure.
- If a wait times out, report that the review is still pending and continue waiting unless the user asked for a time limit.
- Close completed review subagents after collecting their final messages.

## Rules

- Do not auto-fix.
- Do not auto-rerun.
- Do not auto-close issues.
- Do not merge Standards and Spec into one verdict.
- Do not let one axis mask the other.
- If subagent isolation is unavailable, report that limitation instead of pretending it ran normally.
- Treat a caller-specified supported model as higher priority than `.codex/harness.yaml` and the lightest-model fallback.

## Output

- fixed point
- Standards findings
- Spec findings
- per-axis summary
- unresolved blockers
