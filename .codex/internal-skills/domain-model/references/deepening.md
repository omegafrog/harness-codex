# Tactical design stages: shared rules

`domain-model`, `aggregate-design`, `domain-service`, `application-service`, `integration-design` and `context-boundary` run in this order after `requirements-fix` and before `spec-me`. Each fills its own section of `docs/specs/<plan-set-id>/tactical-design.md` ([template](template.md)) and the project model rows it owns. This reference owns what the six stages share; each GUIDE owns its own decisions.

## Start

- Run the preflight and resolve every plan set document with `harness-spec-path.mjs`, as the stage GUIDE says. The input is `requirements.md` with `상태: fixed`; when it is missing or still `draft`, return `blocked` / `INPUT_MISSING`.
- When `stakeholder-analysis.md` has `판정: 생략`, none of the six stages writes anything: record the skip and its evidence path in the summary and return `completed/OK`.
- On resume, read the previous result, the sections already written and the actual answers; keep every decision already recorded and continue at the first step whose output is missing. A previous `blocked` result is evidence of that attempt only (see Relaunch after a block).
- Earlier sections are settled input. Read them and never edit them, except through a user revision of the stage that owns them.
- The document is `docs/specs/<plan-set-id>/tactical-design.md`, named for the flow and not for a stage. A stage writes only its own section and its rows of `## 7` there, and a user instruction that names a stage (`domain-model`, `aggregate-design`, ...) refers to that stage's work and recorded state, never to a file: "leave `domain-model` as it is" means do not reopen that stage, and it does not stop a later stage from writing its own section. `docs/architecture/domain-model.md` is a different file, the project's model index.
- A plan set that an earlier Harness started may hold the document as `domain-model.md`. The runner renames it to `tactical-design.md` (as `git mv` does, committed with the next tactical stage) before a tactical stage runs, so a stage never renames, copies or recreates it and always finds `tactical-design.md`.

## Terms

Model, service and message names use the terms of `CONTEXT.md` and the `## 3` table of `requirements.md`. A new concept that no term covers goes through the [language lifecycle](../../domain-modeling/references/language-lifecycle.md): add or update the entry in `CONTEXT.md` with its context and the plan set's `tactical-design.md` as source, never reviving a retired term. List `CONTEXT.md` among the artifacts only when this stage changed it, because the runner commits it only then.

## Project model rows

`docs/architecture/domain-model.md` is a project document. Update only the rows of the models this stage touched and the columns this stage owns (see the [template](template.md)), keep every other row and the surrounding text, and mark new rows `accepted-target`. Write `implemented` only for what a `code-research` result shows in code, with `file:line`; an unbuilt model is never `implemented`. List the file among the artifacts when it changed.

## Final gate

No stage runs a gate, and the runner accepts every tactical stage before `context-boundary` as `completed` / `OK` without one. The whole `tactical-design.md` is checked once, when `context-boundary` returns `completed` / `OK`: `harness-native-stage.mjs finish` runs `node .codex/scripts/harness-domain-model-check.mjs` on `requirements.md` and sections 1 to 6 before it commits or records anything, and the state command and a recovery record refuse to record `context-boundary` as completed while it fails. The gate holds only what must be true whatever the design, finds tables by their key columns and ignores columns it does not know. Every stage writes toward these checks:

- the documents exist and sections `## 1` to `## 6` are present;
- every `BIZ` maps to a model or an `외부 시스템` marker in `### 1.4`, and every `INV` and `EX` to an owning model;
- every `INV` and `EX` has a non-empty enforcing behaviour in `### 2.2`, in any form: an Aggregate or Entity method, a Value Object's rule (`Value Object: <모델>` or `Value Object: <모델>.<행위>()`), a Domain Service or an `외부 시스템`;
- every rule that spans more than one Aggregate (its `### 2.2` row or a decision that lists it names two or more) cites a consistency decision `CON-xx` of `### 2.3` whose `일관성` is `즉시` or `최종` and whose source is not an agent proposal;
- a transaction boundary of section 4 changes at most one Aggregate;
- Saga and Outbox appear in section 5 only on a row that cites a `최종` decision.

The rest is design judgement that the stage GUIDEs and the reviews own; the gate never rejects it, so each stage keeps to it by its own guide:

- A Root is an Entity and every Entity belongs to exactly one Aggregate. A bounded context of Value Objects or without a state lifecycle has no Aggregate and says why in `### 2.1`; no Entity or Aggregate is created only to hold a rule that a value owns.
- `즉시` merges only Aggregates of one bounded context that one operation changes together; an Aggregate that the operation only reads goes in `조회 전용 Aggregate`. A `즉시` decision across bounded contexts is never merged: an `INT` row of section 5 cites the `CON-xx` with a synchronous `통신 방식` and a `근거·출처` (`integration-design`).
- A rule row of `### 2.2` names the Aggregates its rule changes, and a decision's `규칙` lists the rules it decides.
- A Domain Service exists only for a rule that `### 2.2` hands over, and every handed-over rule has one; no service takes a rule that an Aggregate or a Value Object enforces.
- Every `BIZ` that an external system does not own alone has an Application Service, and every use case names its transaction or `없음 — <이유>`.
- Every eventual-consistency decision across contexts has an integration row, and each integration row names its upstream, downstream and `통신 방식`.
- Every stage leaves at least one decision row of its own in section 7, with its source.

A failing gate comes back from `finish` as `gate_error` and `context-boundary` stays `running`. Every error carries `owner_stage`, the stage whose section is wrong, and the errors are ordered from the earliest stage. The caller hands the errors to the `context-boundary` subagent:

- Errors owned by `integration-design` are reported as earlier-stage findings; only `context-boundary` repairs section 6 and its rows of section 7, never by editing `requirements.md` or an earlier section only to make the gate pass.
- An error owned by an earlier stage is not repaired by `context-boundary`: earlier sections are settled input. The subagent returns `blocked` / `DEPENDENCY_INCOMPLETE` naming the earliest `owner_stage` with the errors as evidence, changing nothing else (it restores `tactical-design.md` to the content it had when the stage started, its committed content, so the restart finds a clean tree), and the orchestrator reopens that stage through the paths below (`--restart-requirements true` or `--user-revision true --feedback`).

A flow whose `stakeholder-analysis.md` says `판정: 생략` passes without documents. `blocked` and `action_required` results are never gated.

## Iterative deepening

Design work can show that the requirements or an earlier stage missed something. The stage never papers over it.

1. A new business rule or exception surfaced by a question's answer or by this stage's design work enters `requirements.md` before this stage's own section depends on it. Only the stages that may ask the user (`aggregate-design`, `integration-design`, `context-boundary`) add one, and only from the user's answer or instruction in this stage's own batch. Add `INV-xx` or `EX-xx` to the owning `BIZ` with the next unused number, an `AC-xx` that observes it, the source `answers.json` with the `question_id`, and one line in that `BIZ`'s `출처·변경 이력` naming this stage. Never edit an existing item, and never reuse a number.
2. The new rule must reach the mapping tables the final gate reads. When existing models, Aggregates and behaviours can own it, append rows for it to `### 1.4` and, past `aggregate-design`, to `### 2.2`, never changing an existing row, and add a `DEC` row naming the rule. Anything beyond rows of those two tables (a new or changed model, Aggregate, consistency decision, Domain Service or use case) belongs to an earlier stage and is step 4.
3. A stage that may not ask (`domain-model`, `domain-service`, `application-service`) never adds a rule on its own judgement. When the evidence is missing or contradictory, return `blocked` / `INPUT_MISSING`: the summary names the `BIZ`, `INV` or `EX`, what is missing and that the requirements need a revision. The orchestrator reports it, and the user's revision is a `requirements-fix` user revision, after which the stage resumes with `--feedback`.
4. When the new rule, an answer or the design work invalidates a decision of an earlier tactical stage, return `blocked` / `DEPENDENCY_INCOMPLETE` instead of overwriting that stage's section. The summary names the earliest stage to reopen, the decision, the evidence (IDs, rows, the answer) and the new rule when there is one. Leave the earlier section and every other file untouched except the rule added to `requirements.md`, which the runner commits for this block so the working tree stays clean and the rule survives the restart.
5. The orchestrator reports the block. The user reopens the earlier stage through the existing paths: `--restart-requirements true` for that stage (the runner restores its tactical documents but keeps `requirements.md`, drops it and every later stage from the state, and the stage runs again), or `--user-revision true --feedback <instruction>` for a completed stage. A requirements revision that also needs a restart comes after the restart.

## Relaunch after a block

A stage relaunched with `--feedback` or a user revision after a `blocked` result reads that result (`context.previous_result_note`) as evidence of the earlier attempt, never as the current state: the documents, Harness or the gate may have changed since, as the user's instruction often says. Gate errors and blockers it names are not facts to repeat.

- Before it blocks on an earlier stage's error, the stage re-runs the current gate on the current documents: `node .codex/scripts/harness-domain-model-check.mjs --workspace-root <absolute workspace root>`. This is a read-only look at the verdict, not a gate of its own.
- It blocks only on errors that this run still reports for earlier stages, with that output as the evidence. Errors it owns are repaired; errors that no longer appear are dropped.
- When nothing is left for an earlier stage, the previous block no longer holds: the stage does its own work (`context-boundary` designs `## 6`) and returns by the table below. Another blocker, such as a missing input, is re-checked the same way before it is repeated.

## User revision

When the input carries `context.user_revision`, change only the rows the instruction names, record the instruction verbatim as a `DEC` row with the source `사용자 수정 지시`. When a later stage's section already depends on a changed row, list those stages in the summary as `영향받는 이후 stage`: the orchestrator then restarts from this stage instead of leaving them stale, and the rerun reaches the final gate at `context-boundary`.

## Returns

| Situation | Return |
|---|---|
| The section is written (`context-boundary`: the runner's final gate then decides) | `completed` / `OK` with the artifacts this stage wrote |
| A user decision is needed (`aggregate-design`, `integration-design`, `context-boundary` only) | `action_required` / `USER_DECISION_REQUIRED`, one batch, in Korean, with each option's business consequence, a recommended option and its rationale |
| `requirements.md` is not fixed, or evidence is missing for a stage that may not ask | `blocked` / `INPUT_MISSING` |
| An earlier tactical decision is invalidated | `blocked` / `DEPENDENCY_INCOMPLETE` |
| Skip | `completed` / `OK` without writing |
