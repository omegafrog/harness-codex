# Tactical design stages: shared rules

`domain-model`, `aggregate-design`, `domain-service`, `application-service` and `integration-design` run in this order after `requirements-fix` and before `spec-me`. Each fills its own section of `docs/specs/<plan-set-id>/domain-model.md` ([template](template.md)) and the project model rows it owns. This reference owns what the five stages share; each GUIDE owns its own decisions.

## Start

- Run the preflight and resolve every plan set document with `harness-spec-path.mjs`, as the stage GUIDE says. The input is `requirements.md` with `상태: fixed`; when it is missing or still `draft`, return `blocked` / `INPUT_MISSING`.
- When `stakeholder-analysis.md` has `판정: 생략`, none of the five stages writes anything: record the skip and its evidence path in the summary and return `completed/OK`.
- On resume, read the previous result, the sections already written and the actual answers; keep every decision already recorded and continue at the first step whose output is missing.
- Earlier sections are settled input. Read them and never edit them, except through a user revision of the stage that owns them.

## Terms

Model, service and message names use the terms of `CONTEXT.md` and the `## 3` table of `requirements.md`. A new concept that no term covers goes through the [language lifecycle](../../domain-modeling/references/language-lifecycle.md): add or update the entry in `CONTEXT.md` with its context and the plan set's `domain-model.md` as source, never reviving a retired term. List `CONTEXT.md` among the artifacts only when this stage changed it, because the runner commits it only then.

## Project model rows

`docs/architecture/domain-model.md` is a project document. Update only the rows of the models this stage touched and the columns this stage owns (see the [template](template.md)), keep every other row and the surrounding text, and mark new rows `accepted-target`. Write `implemented` only for what a `code-research` result shows in code, with `file:line`; an unbuilt model is never `implemented`. List the file among the artifacts when it changed.

## Gate

Before returning `completed`, run `node .codex/scripts/harness-domain-model-check.mjs --workspace-root <workspace_root> --stage <this stage>`. It reads `requirements.md` and `domain-model.md` and checks, for the sections filled up to this stage:

- every `BIZ` maps to at least one model or `외부 시스템` marker;
- every `INV` and `EX` maps to an owning model and, from `aggregate-design` on, to an enforcing behaviour: an Aggregate method listed in the Aggregate's `주요 행위`, a Domain Service, or an `외부 시스템` that owns the rule;
- every rule that spans Aggregates has a consistency decision (`CON-xx`) with a source that is not an agent proposal;
- later sections add their own checks (Domain Service coverage, one Aggregate per transaction, Saga/Outbox only for eventual consistency) and every stage leaves at least one decision row of its own in section 6, with its source.

A failing gate means the stage is not complete: fix the document and run it again. Never return `completed` with a failing gate, and never change `requirements.md` or an earlier section only to make the gate pass.

The runner enforces the gate; running it first is how a stage avoids being sent back. When the runner receives a `completed` / `OK` result of one of these stages, `harness-native-stage.mjs finish` runs the same check on the workspace before it commits or records anything, and the state command and a recovery record refuse to record the stage as completed while it fails. A rejected result is returned as `gate_error` with the findings; the stage stays `running`, the caller hands the findings to the same subagent, and the subagent repairs `domain-model.md` and returns again. A flow whose `stakeholder-analysis.md` says `판정: 생략` passes without documents. `blocked` and `action_required` results are never gated.

## Iterative deepening

Design work can show that the requirements or an earlier stage missed something. The stage never papers over it.

1. A new business rule or exception surfaced by a question's answer or by this stage's design work enters `requirements.md` before this stage's own section depends on it. Only the stages that may ask the user (`aggregate-design`, `integration-design`) add one, and only from the user's answer or instruction in this stage's own batch. Add `INV-xx` or `EX-xx` to the owning `BIZ` with the next unused number, an `AC-xx` that observes it, the source `answers.json` with the `question_id`, and one line in that `BIZ`'s `출처·변경 이력` naming this stage. Never edit an existing item, and never reuse a number.
2. The new rule must reach the mapping tables the gate reads. When existing models, Aggregates and behaviours can own it, append rows for it to `### 1.4` and, past `aggregate-design`, to `### 2.2`, never changing an existing row, and add a `DEC` row naming the rule. Anything beyond rows of those two tables (a new or changed model, Aggregate, consistency decision, Domain Service or use case) belongs to an earlier stage and is step 4.
3. A stage that may not ask (`domain-model`, `domain-service`, `application-service`) never adds a rule on its own judgement. When the evidence is missing or contradictory, return `blocked` / `INPUT_MISSING`: the summary names the `BIZ`, `INV` or `EX`, what is missing and that the requirements need a revision. The orchestrator reports it, and the user's revision is a `requirements-fix` user revision, after which the stage resumes with `--feedback`.
4. When the new rule, an answer or the design work invalidates a decision of an earlier tactical stage, return `blocked` / `DEPENDENCY_INCOMPLETE` instead of overwriting that stage's section. The summary names the earliest stage to reopen, the decision, the evidence (IDs, rows, the answer) and the new rule when there is one. Leave the earlier section and every other file untouched except the rule added to `requirements.md`, which the runner commits for this block so the working tree stays clean and the rule survives the restart.
5. The orchestrator reports the block. The user reopens the earlier stage through the existing paths: `--restart-requirements true` for that stage (the runner restores its tactical documents but keeps `requirements.md`, drops it and every later stage from the state, and the stage runs again), or `--user-revision true --feedback <instruction>` for a completed stage. A requirements revision that also needs a restart comes after the restart.

## User revision

When the input carries `context.user_revision`, change only the rows the instruction names, record the instruction verbatim as a `DEC` row with the source `사용자 수정 지시`, and run the gate again. When a later stage's section already depends on a changed row, list those stages in the summary as `영향받는 이후 stage`: the orchestrator then restarts from this stage instead of leaving them stale.

## Returns

| Situation | Return |
|---|---|
| Gate passes | `completed` / `OK` with the artifacts this stage wrote |
| A user decision is needed (`aggregate-design`, `integration-design` only) | `action_required` / `USER_DECISION_REQUIRED`, one batch, in Korean, with each option's business consequence, a recommended option and its rationale |
| `requirements.md` is not fixed, or evidence is missing for a stage that may not ask | `blocked` / `INPUT_MISSING` |
| An earlier tactical decision is invalidated | `blocked` / `DEPENDENCY_INCOMPLETE` |
| Skip | `completed` / `OK` without writing |
