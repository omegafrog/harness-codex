---
name: diagnosing-bugs
description: Diagnose a broken behavior or regression with reproduce → minimise → hypothesise → instrument → fix → regression-test.
---

# diagnosing-bugs

## Flow

1. Build a runnable feedback loop that already goes red on the reported bug.
2. Reproduce and minimise the failure.
3. Rank falsifiable hypotheses before testing them.
4. Instrument one variable at a time.
5. Fix the bug.
6. Write the regression test at the correct seam.

## Rules

- Do not skip reproduction.
- Do not hypothesise before the loop is red.
- Do not claim done without a regression test or an explicit seam blocker.
