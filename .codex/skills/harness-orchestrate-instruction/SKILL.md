---
name: harness-orchestrate-instruction
description: Route one user instruction through the selected workflow and specialist subagents.
---

# Harness Orchestration Sequence

1. Get current workflow facts through runtime context.
2. Select one next step from `needs`, current result, and blocker evidence.
3. Dispatch that selected step through runtime.
4. Read returned fact (`review_rejected`, `verification_root_cause`, protocol, environment, or upstream) and select an owning repair/retry/producer step when available.
5. Complete only after declared gates pass. Return Korean workflow status.

## Boundaries

- Runtime owns existing XML handoff creation and specialist lifetime.
- Do not read files or spawn specialists directly.
