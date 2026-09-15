---
name: evaluate-harness
description: Evaluate Harness workflow changes with the repo's eval suites, compare against suite baselines, and report quality, correctness, token, latency, and inconclusive regressions.
---

# evaluate-harness

## Purpose

Use `evaluate-harness` to answer: **did this Harness change make the agent/workflow better, worse, or inconclusive?**

This skill orchestrates the existing eval framework. It does not invent a second evaluator and it does not replace `code-review`.

- `code-review` evaluates an implementation diff against Product/Architecture contracts.
- `evaluate-harness` evaluates Harness skills, workflows, agents, and eval infrastructure against `evals/suites/*`.

## Preconditions

Run this skill from a Harness source checkout that contains all of the following:

```text
.codex/harness.yaml
evals/suites/
evals/cases/
bin/harness-eval.mjs
```

If these files are absent, stop and report that the current repository does not contain the Harness eval source. Do not pretend that an installed consumer project's application code is being evaluated by these suites.

## Inputs

Use, in priority order:

1. A suite explicitly named by the user.
2. A user-supplied base ref or comparison range.
3. Otherwise, the current Git diff and available suite manifests.

Read `.codex/harness.yaml`, `evals/suites/*.yaml`, and the referenced case manifests before running an eval.

## Suite Selection

Select suites deterministically.

1. If the user names a suite, run that suite.
2. If common eval infrastructure changed (`src/eval/**`, `bin/harness-eval.mjs`, eval config/schema, shared grader/recording/workspace code), run every available suite.
3. If a Harness skill or workflow changed, inspect suite case manifests and select suites containing cases for the affected workflow(s).
4. If no exact mapping is available and `p0` exists, run `p0` as the smoke/regression suite and explicitly report that coverage is limited to `p0`.
5. Never claim full Harness coverage when only a subset of suites ran.

When only one suite exists, use it unless the user explicitly requests otherwise.

## Execute

Prefer the repository-local runner so the current checkout is what gets evaluated:

```bash
node bin/harness-eval.mjs run --suite <suite-id>
```

Use `--config <path>` only when the user supplied a non-default config or the repository clearly requires one.

Do not silently switch to a remote/package version of Harness because that would evaluate different source than the current checkout.

For each suite, capture the CLI result and the generated run directory. Read at least:

```text
<run-dir>/result.json
<run-dir>/report.json
```

`result.json` is the compact machine verdict. `report.json` contains per-case quality, efficiency, hard-gate, outcome, and regression details.

## Evaluate

Do not reduce the result to only pass/fail. Report the dimensions already produced by the eval framework.

Required dimensions:

- suite state: `passed`, `failed`, or `inconclusive`
- case counts: passed / failed / inconclusive
- hard-gate failures
- critical-case pass rate
- overall pass rate
- mean quality
- p10 quality
- token regression vs suite baseline
- latency regression vs suite baseline
- per-case token/latency regressions when present
- inconclusive rate and reasons

Use each suite's own `thresholds` and `baseline`. Do not hardcode alternative thresholds in the skill.

A regression ratio is interpreted as:

```text
(current - baseline) / baseline
```

Positive values mean increased cost/latency. Whether that increase is acceptable is determined by the suite threshold, not by the skill.

## Diagnose Failures

When a suite fails, identify the first useful layer of failure rather than only repeating `failed`.

Classify findings into:

```text
Correctness
- hard gate violation
- required outcome failure
- critical case failure
- pass-rate failure

Quality
- mean quality below threshold
- p10 quality below threshold

Efficiency
- token regression
- latency regression
- per-case regression

Evaluation health
- inconclusive case
- auth/environment failure
- corrupted recording/trajectory
- cleanup/workspace failure
```

For failed or regressed cases, name the case id and the failed check. Read the relevant per-case section of `report.json` before proposing a cause.

Do not label an inconclusive environment problem as a product/workflow regression.

## Retry Policy

Respect the suite manifest retry policy.

- Do not automatically retry ordinary `failed` cases unless the suite explicitly allows it.
- Retry `inconclusive` only when the suite policy permits and the underlying cause is plausibly transient.
- When retrying, use a new run id/attempt according to the suite contract and preserve the original attempt result.
- Report first-attempt and retry results separately.

## Baseline Safety

Never update a suite baseline just to make a failing run pass.

Baseline changes are a separate deliberate action and require explicit user approval after a successful, representative run. If the user did not ask to update the baseline, evaluation is read-only apart from normal eval runtime artifacts.

## Output

Write the final answer in Korean and keep it compact. Use this shape:

```text
Harness Eval: PASS | FAIL | INCONCLUSIVE

Suite: <suite-id>
Cases: <passed>/<total> passed, <inconclusive> inconclusive
Quality: mean <value>, p10 <value>
Efficiency: tokens <ratio>, latency <ratio>
Failed checks: <none or check names>

Main findings
1. <highest-impact finding>
2. <next finding>

Coverage
- <what was evaluated>
- <what was not evaluated>
```

If all checks pass, say that the selected suite passed against its declared baseline and thresholds. Do not generalize that to every Harness behavior unless every relevant suite ran.

If evaluation cannot run, return `INCONCLUSIVE` with the exact blocker and the minimum condition needed to rerun.
