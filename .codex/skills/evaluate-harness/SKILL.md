---
name: evaluate-harness
description: Evaluate Harness workflow changes with the repo's eval suites, compare against suite baselines, and report quality, correctness, token, latency, and inconclusive regressions.
---

# evaluate-harness

## Purpose

Use `evaluate-harness` to answer: **did this Harness change make the agent/workflow better, worse, or inconclusive?**

This skill orchestrates the existing eval framework. It does not invent a second evaluator and it does not replace `code-review`.

- `code-review` evaluates an implementation diff against Product/Architecture contracts.
- `evaluate-harness` evaluates Harness skills, workflows, agents, and eval infrastructure against the Harness package's `evals/suites/*`.

It evaluates Harness itself, not the consumer application's product behavior.

## Execution Modes

Support both source checkout and installed-consumer usage.

### Source checkout mode

If the current repository contains all of the following, evaluate that local checkout:

```text
.codex/harness.yaml
evals/suites/
evals/cases/
bin/harness-eval.mjs
```

Run:

```bash
node bin/harness-eval.mjs run --suite <suite-id>
```

This evaluates the current Harness checkout, including local Harness changes.

### Installed mode

If the current repository only contains installed Harness assets such as `.agents/skills/*`, `.codex/agents/*`, and `.codex/harness.yaml`, do **not** fail merely because `evals/` or `bin/harness-eval.mjs` is absent.

Run the Harness package-backed evaluator instead:

```bash
npx --yes --package github:omegafrog/harness-codex \
  harness-eval run --suite <suite-id>
```

`harness-eval` resolves suites, cases, fixtures, recordings, and the eval implementation from its own Harness package root, so consumer repositories do not need copies of `evals/`, `bin/`, or `src/eval/`.

Installed mode evaluates the Harness package resolved by that package command. It does not evaluate arbitrary local edits made directly to copied `.agents/skills/*` files in the consumer repository. If local Harness-source modifications must be evaluated, use source checkout mode.

Only return `INCONCLUSIVE` for missing eval source when neither the local source checkout nor the package-backed command can be used.

## Inputs

Use, in priority order:

1. A suite explicitly named by the user.
2. A user-supplied base ref or comparison range in source checkout mode.
3. Otherwise, the current Harness source diff when available and the package's available suite manifests.

In source checkout mode, read `.codex/harness.yaml`, `evals/suites/*.yaml`, and the referenced case manifests before running an eval.

In installed mode, obtain suite/case information from the package-backed evaluator or package source; do not require those files in the consumer project.

## Suite Selection

Select suites deterministically.

1. If the user names a suite, run that suite.
2. In source checkout mode, if common eval infrastructure changed (`src/eval/**`, `bin/harness-eval.mjs`, eval config/schema, shared grader/recording/workspace code), run every available suite.
3. If a Harness skill or workflow changed and suite case mapping is available, select suites containing cases for the affected workflow(s).
4. If no exact mapping is available and `p0` exists, run `p0` as the smoke/regression suite and explicitly report that coverage is limited to `p0`.
5. Never claim full Harness coverage when only a subset of suites ran.

When only one suite exists, use it unless the user explicitly requests otherwise.

## Execute

Use the mode-specific command above. Do not copy Harness eval implementation into a consumer repository just to run evaluation.

Use `--config <path>` only in source checkout mode when the user supplied a non-default config or that Harness checkout clearly requires one. Do not pass a consumer repository config path to package-backed installed mode.

For each suite, capture the CLI result and generated run directory. Read at least:

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

If evaluation cannot run, return `INCONCLUSIVE` with the exact blocker and minimum condition needed to rerun.
