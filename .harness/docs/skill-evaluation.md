# Skill Evaluation Framework

## 1. Purpose

The skill evaluation framework checks whether harness skills keep producing the
expected workflow artifacts, preserve stage boundaries, and avoid quality drift
across prompt, model, and instruction changes.

This framework evaluates skill behavior. It does not replace runtime pytest,
workflow loader tests, or UI verification. Runtime tests prove code behavior.
Skill evaluations prove that agent-facing instructions still lead to usable
documents and safe handoffs.

## 2. Evaluation Targets

The minimum target set is:

- `harness-requirements`
- `harness-usecases`
- `harness-event-storming`
- `harness-ddd-design`
- `harness-technical-decisions`
- `harness-code-planner`
- `harness-plan-executor`

Each target must have at least one prompt case in
`.harness/docs/skill-evaluation/prompt-corpus.json`.

## 3. Result Location

Generated evaluation results belong under:

```text
.harness/skill-evaluations/<run-id>/
```

This path is ignored by Git. Keep committed evaluation inputs and schemas under
`.harness/docs/skill-evaluation/`. Keep generated transcripts, measured timings, token
counts, artifacts, and score reports under `.harness/skill-evaluations/`.

## 4. Evaluation Flow

1. Select prompt cases from `.harness/docs/skill-evaluation/prompt-corpus.json`.
2. Run each case with the target skill enabled.
3. Run the same case without the target skill when the case requires a baseline.
4. Store generated artifacts, transcript summary, timing, and token metrics under
   `.harness/skill-evaluations/<run-id>/`.
5. Score artifacts with assertions from
   `.harness/docs/skill-evaluation/assertion-schema.json`.
6. Compare with-skill results against baseline results.
7. Fail the evaluation when required artifacts are missing, forbidden paths are
   edited, required headings are absent, stage boundaries are crossed, or quality
   metrics regress beyond the configured threshold.

## 5. Assertion Types

Machine-checkable assertions should use these families:

- `artifact_exists`: required output path exists.
- `heading_exists`: required markdown heading exists.
- `path_not_modified`: forbidden path was not changed.
- `text_includes`: required text exists in an artifact.
- `text_excludes`: forbidden text is absent from an artifact.
- `json_path_equals`: structured result field has expected value.
- `metric_at_most`: timing, token, or score metric is below a threshold.
- `metric_at_least`: score or coverage metric is above a threshold.

Assertion results must include pass/fail status, evidence path, and a short
failure reason when status is `fail`.

## 6. Stage Boundary Rules

Skill evaluations must verify stage boundaries explicitly:

- Requirements work may update requirements artifacts, but must not generate
  use-case slices or runtime code.
- Use-case work may generate use-case slices, but must not edit runtime code,
  skill files, agent files, requirements documents, or `context.md`.
- Event-storming work must stay inside the selected use-case slice.
- DDD design work must produce domain design artifacts without generating code.
- Technical-decision work must decide retry, idempotency, transaction,
  observability, and adapter strategy where relevant.
- Code-planning work must write only the active plan for the selected work item.
- Plan-execution work must leave verification commands and results in the plan.

## 7. Minimum Smoke Command

Run the committed framework smoke test with:

```bash
./venv/bin/python3 -m pytest -q -s tests/test_skill_evaluation_contract.py
```

Run the broader documentation and skill contract tests when changing skill
instructions, prompt corpus cases, or assertion rules:

```bash
./venv/bin/python3 -m pytest -q -s tests/test_skill_evaluation_contract.py tests/test_harvester_skill_instructions.py tests/test_usecase_slice_harvest_instructions.py tests/test_plan_executor_use_case_loop.py tests/test_planner_work_item_alignment.py
```
