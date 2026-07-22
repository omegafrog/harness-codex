---
name: diagnosing-bugs
description: Diagnose hard bugs and performance regressions through reproduce → minimise → hypothesise → instrument → fix → regression-test.
---

# diagnosing-bugs

## What it does

`diagnosing-bugs` handles broken behavior and performance regressions.

It does not start from a spec. It starts from a runnable feedback loop, then tightens the repro until the failure is small enough to debug and lock down.

## Flow

1. Build a feedback loop that already goes red on the reported bug.
2. Reproduce the exact symptom.
3. Minimise the repro until every remaining step is load-bearing.
4. Rank falsifiable hypotheses before testing them.
5. Instrument one variable at a time.
6. Fix the bug.
7. Write the regression test at the correct seam.

## Rules

- Do not hypothesise before there is a red-capable loop.
- Do not proceed without reproducing the reported failure.
- Do not settle for a nearby failure that is not the reported bug.
- Prefer the highest correct seam for the regression test.
- If no correct seam exists, report that the architecture is the blocker.

## Output

- repro loop
- minimised scenario
- ranked hypotheses
- instrumentation notes
- fix summary
- regression test seam

## Pulled out on purpose

`diagnosing-bugs` is the bug on-ramp. When the real issue is design depth rather than the bug itself, it hands off to `improve-codebase-architecture` in the original model.
