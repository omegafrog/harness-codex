
내부 절차는 연결된 GUIDE를 따른다:

# to-ticket

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 해당 tier를 우선한다. [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 `harness-skill-execution.mjs binding`이 스킬의 binding과 setup 설정에서 model·effort를 해석한다. `execution_id`를 받은 호출은 해당 stage 파일에 지정된 작업을 수행하고 결과 파일과 공통 envelope를 반환한다.

## Plan authoring stage

`to-ticket` owns plan authoring and its independent review loop. Use [split](references/split.md) on the initial invocation and [revision](references/revision.md) to address findings. It calls a fresh native `plan_reviewer` subagent itself, records the attempt through `harness-plan-review.mjs`, revises plans when needed, and repeats with a different fresh reviewer. It returns `completed/OK` only after `check --phase planning` confirms the canonical review is current and passing. Plan review is never handed to the main orchestrator as `REVIEW_REQUIRED`; actual user decisions use `USER_DECISION_REQUIRED`.

When the user explicitly asks to restart a waiting or failed `to-ticket` stage from its completed `spec-me`, prepare a fresh stage input with `node .codex/scripts/harness-prepare-input.mjs --worktree-ref <canonical-worktree.json> --stage-id to-ticket --restart true`. The runner accepts this only in the active matching worktree, while `spec-me` is completed and no tracker publication journal exists. It archives the prior plan set, review history, and `runtime/to-ticket` artifacts under `.io/runtime/restarts/`; execution history and Specs remain in place. Never use restart to bypass a running stage or reviewer.

- Write canonical plans from the approved Specs, then execute the review loop in this stage. Ask the user only when a necessary decision cannot be resolved from the approved Specs.
- A `revise` verdict causes a scoped plan revision and a new attempt with a new reviewer. Preserve the configured three substantive-attempt limit; after it is reached, return the concrete unresolved decision to the user. User answers do not count as a review pass.
- A `pass` verdict completes plan authoring only after the current snapshot check. The orchestrator requests final user approval of the reviewed plan set before dispatching the separate `tracker-publish` workflow stage. This skill never publishes to the tracker or Beads.

The following publisher is a separate workflow stage, not a nested subagent or an action performed by the orchestrator main session. It owns tracker/Beads publication and returns the final receipt.

The orchestrator presents real user questions and preserves actual answers. A user answer resolves only the asked decision; it does not make a review pass. Standalone use follows the same split → internal independent review → revision when needed and completion gate.
