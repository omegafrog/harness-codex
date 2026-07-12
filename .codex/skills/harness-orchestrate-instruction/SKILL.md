---
name: harness-orchestrate-instruction
description: Route one user instruction through the selected workflow and specialist subagents.
---

# Harness Orchestration Sequence

1. Get current workflow facts through runtime context.
2. Select one next step from `needs`, current result, blocker evidence, and active ChangeSet facts. When `dispatchable_resume_steps` exists, select its matching step before any decision, record, or bootstrap step.
3. Dispatch that selected step through runtime, including `execute-work-item`; this delegates to the specialist and never performs the step work in the parent.
4. Read returned fact (`review_rejected`, `verification_root_cause`, protocol, environment, or upstream) and select an owning repair/retry/producer step when available.
   - `review_rejected` or `verification_root_cause`: select `plan-work-item`, then review again.
   - protocol failure: select the same specialist step again.
   - environment blocker: select the same executor checkpoint.
5. Repeat steps 1-4 until declared gates pass or no owning workflow step exists. Never return only a proposed next step.
6. Return Korean workflow status only after that terminal decision.

## Boundaries

- Runtime owns existing XML handoff creation and specialist lifetime.
- Do not read files or spawn specialists directly.
