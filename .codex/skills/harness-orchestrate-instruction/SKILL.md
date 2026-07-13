---
name: harness-orchestrate-instruction
description: Route one user instruction through the selected workflow and specialist subagents.
---

# Harness Orchestration Sequence

1. Get current workflow facts through runtime context.
2. Select one next dispatchable step from `needs`, current result, blocker evidence, and active ChangeSet facts. Treat `decision` and `record` steps as route predicates only: do not dispatch them and do not create their result. When `dispatchable_resume_steps` exists, select its matching agent or validator step before any bootstrap step.
3. Dispatch only the selected `agent` or `validator` step through runtime, including `execute-work-item`; this delegates to the specialist and never performs the step work in the parent.
4. Read returned fact (`review_rejected`, `verification_root_cause`, protocol, environment, or upstream) and select an owning repair/retry/producer step when available.
   - For `review_rejected`, read `review_rejections` from runtime context. Select a compatible producer only when every blocking finding identifies that producer as its owner. Dispatch `plan-work-item` only when the rejected evidence is its plan output.
   - If a blocking finding has no compatible producer, return terminal `blocked` with its evidence path and message. Do not retry or alter an unrelated artifact.
   - For `verification_root_cause`, select the compatible owner from runtime facts before retrying review.
   - protocol failure: select the same specialist step again.
   - environment blocker: select the same executor checkpoint.
5. Repeat steps 1-4 until declared gates pass or no owning workflow step exists. Never return only a proposed next step.
6. Return Korean workflow status only after that terminal decision.

## Boundaries

- Runtime owns existing XML handoff creation and specialist lifetime.
- Do not read files or spawn specialists directly.
