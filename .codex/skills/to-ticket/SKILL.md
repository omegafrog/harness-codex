---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation plans, review them independently, and publish the passing plan set.
---

내부 절차는 연결된 GUIDE를 따른다:

# to-ticket

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 해당 tier를 우선한다. [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 `harness-skill-execution.mjs binding`이 스킬의 binding과 setup 설정에서 model·effort를 해석한다. `execution_id`를 받은 호출은 해당 stage 파일에 지정된 작업을 수행하고 결과 파일과 공통 envelope를 반환한다.

## Plan authoring stage

`to-ticket` is one executor stage. Use [split](references/split.md) on the initial invocation, [revision](references/revision.md) when resumed with a recorded `revise` review, and [finalize](references/finalize.md) when resumed with a recorded `pass` review. The reviewer is never an executor stage: after the author returns `REVIEW_REQUIRED`, the main orchestrator calls a fresh native `plan_reviewer` subagent, records the result, then resumes this same author session with `harness-prepare-input.mjs --feedback`.

- No review feedback: obtain the user's actual approval for the proposed split, write canonical plans, then return `REVIEW_REQUIRED` with a `review_request` and a session context artifact.
- Review feedback with `verdict=revise`: read the exact record path, repair only the plan set in scope, then return `REVIEW_REQUIRED` for a new review attempt.
- Review feedback with `verdict=pass`: verify the record and current snapshot with `harness-plan-review.mjs check --phase planning`, then complete plan authoring. The orchestrator dispatches the separate `tracker-publish` workflow stage next; this skill never publishes to the tracker or Beads.

The following publisher is a separate workflow stage, not a nested subagent or an action performed by the orchestrator main session. It owns tracker/Beads publication and returns the final receipt.

The orchestrator presents real user questions and preserves actual answers. A user answer resolves only the asked decision; it does not make a review pass. Standalone use follows the same split → orchestrator review → author resume loop and completion gate.
