---
name: harness-orchestrate-instruction
description: Continue one ChangeSet in the current Codex session through specialist skills.
---

# Current-Session Orchestration

1. Resolve exactly one ChangeSet and work item from the user request and its documents. If the mapping is ambiguous, stop and request that mapping; never combine artifacts from different ChangeSets.
2. Select and invoke one native specialist subagent in this Codex session: ChangeSet→`harness-change-set-bootstrap`; maintenance slice→`harness-maintenance-bootstrap`; technical decisions→`harness-technical-decisions`; plan→`harness-code-planner`; plan review→`harness-artifact-reviewer`; implementation→`harness-implementation-executor`; security review→`harness-security-implementation-reviewer`.
3. Inspect only that specialist's declared document change and concise result. Invoke the next specialist skill; do not execute that skill's work yourself.
4. On rejection or blocker, route to the named owner: repair producer artifacts, then re-run the reviewer; investigate verification evidence before retrying an executor.
5. Continue until the work item is verified or a concrete user/environment blocker remains.

Never call a harness workflow command or runtime module. Runtime utilities may validate documents or display status only; they never select, run, retry, or host agents.
