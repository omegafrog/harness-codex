# harness-full-workflow Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-full-workflow/SKILL.md`

---
name: harness-full-workflow
description: Run the full harness workflow by orchestrating harness-requirements, harness-usecases, and harness-post-harvest-orchestrator as one resumable flow from early idea through execution. Use when the user wants one skill to carry requirements, use cases, ChangeSet creation, UC slices, event storming, DDD design, technical decisions, planning, execution, verification, and ChangeSet completion while preserving stage state across grill-me and approval pauses.
---

# Harness Full Workflow

## Purpose

Use this wrapper when the user wants one skill to drive the full harness flow
from early idea to execution.

This skill does not replace the specialist skills. It sequences them, preserves
state across pauses, and resumes from the current gate.

Specialist skills:

- `$harness-requirements`
- `$harness-usecases`
- `$harness-post-harvest-orchestrator`

## Entry Conditions

Use this skill only when the user wants these stages treated as one workflow:

1. requirements generation
2. use-case generation
3. post-harvest orchestration through execution

If the user wants only one stage, invoke the specialist skill directly instead.

## State Model

Maintain wrapper state across the entire session. Do not drop it after a user
reply, tool pause, compaction, or specialist-skill question loop.

Track at least:

- `current_stage`
- `current_skill`
- `requirements_status`
- `usecases_status`
- `post_harvest_status`
- `pending_grill_me_questions`
- `pending_grill_me_answers`
- `active_change_set_id`
- `affected_uc_ids`
- `pending_approval_gate`

Valid `current_stage` values:

- `requirements`
- `usecases`
- `post-harvest`
- `waiting-for-user`
- `complete`

## Orchestration Rules

1. Announce which specialist skill is being invoked.
2. Run only one specialist skill at a time.
3. Treat `grill-me` as a blocking sub-loop inside `requirements`, not as a
   workflow failure.
4. Do not invoke `$harness-usecases` until requirements are complete.
5. Do not invoke `$harness-post-harvest-orchestrator` until use cases are
   complete.
6. Preserve state and resume from the current gate after every user reply.
7. Do not bypass approval gates owned by downstream skills.

## Requirements Stage

Set:

- `current_stage=requirements`
- `current_skill=harness-requirements`

Invoke `$harness-requirements`.

If it invokes `grill-me`:

- keep `current_stage=requirements`
- set `pending_grill_me_questions`
- move to `waiting-for-user`
- store user answers in `pending_grill_me_answers`
- resume `$harness-requirements` with accumulated answers
- do not invoke use cases or post-harvest while `grill-me.complete != true`

Requirements stage completes only when:

- `docs/design/요구사항.md` exists and is non-empty
- unresolved core business policy decisions do not block use-case writing

## Use Cases Stage

After requirements completion:

- `current_stage=usecases`
- `current_skill=harness-usecases`

Invoke `$harness-usecases`.

If the use-case skill asks clarification questions:

- keep `current_stage=usecases`
- move to `waiting-for-user`
- resume use-case generation after the user answers

Use-cases stage completes only when:

- `docs/design/유스케이스.md` exists and is non-empty

## Post-Harvest Stage

After use-case completion:

- `current_stage=post-harvest`
- `current_skill=harness-post-harvest-orchestrator`

Invoke `$harness-post-harvest-orchestrator`.

Respect all of its gates, especially:

- ChangeSet creation
- affected UC identification
- UC slice creation
- event storming
- staged DDD approvals
- technical decision completion
- final approval before planning
- mandatory plan execution after approval

If the orchestrator stops for approval or clarification:

- keep `current_stage=post-harvest`
- record `pending_approval_gate`
- move to `waiting-for-user`
- resume from that exact gate after user input

## Resume Rules

On every new user reply during an active wrapper run:

1. Check wrapper state first.
2. If `pending_grill_me_questions` exists, route the reply back to
   `$harness-requirements`.
3. Else if `current_stage=usecases` and use-case clarification is pending,
   route the reply back to `$harness-usecases`.
4. Else if `pending_approval_gate` exists, route the reply back to
   `$harness-post-harvest-orchestrator`.
5. Else continue with the next stage in sequence.

Do not restart from requirements unless the user explicitly asks to regenerate
requirements or downstream artifacts became stale because an upstream stage was
regenerated.

## Regeneration Rules

If requirements are regenerated:

- rerun use cases
- rerun post-harvest from the earliest invalid downstream gate

If use cases are regenerated:

- rerun post-harvest from affected use-case selection or later, depending on
  artifact impact

If a downstream skill reports that an upstream artifact is unresolved or stale,
return to the owning stage and continue from there.

## Completion

Workflow completes only when:

- requirements completed
- use cases completed
- post-harvest orchestration completed
- all affected UC plans completed
- ChangeSet moved to completed state

Then set:

- `current_stage=complete`
- `current_skill=none`
- clear pending questions and pending approvals

## User-Facing Result

When pausing or completing, report:

- current stage
- current skill
- current gate artifact path
- pending question or approval status
- active ChangeSet ID and affected UCs when available
