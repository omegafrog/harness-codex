---
name: harness-orchestrate-instruction
description: Route one ChangeSet request by dispatching its next specialist step.
---

# Orchestration Sequence

1. Get runtime context.
2. Select one eligible `agent` or `validator`; `decision` and `record` are predicates, never dispatch targets.
3. Dispatch it through runtime.
4. For `review_rejected`, `verification_root_cause`, protocol, or environment facts, retry its owner or route its declared producer. A conditional sibling requires its own positive condition; never use it as fallback.
5. Repeat until a gate passes or no compatible owner exists.
