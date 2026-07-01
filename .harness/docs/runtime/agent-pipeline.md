# Runtime Agent Pipeline Model

Harness uses an agent-backed sequential pipeline.

Each workflow step is a runtime action with declared inputs, outputs, and `needs` dependencies. For an agent step, the runtime builds a prompt and invokes the configured specialist agent through `codex exec`. The runtime then validates declared outputs and moves to dependent steps only when the current step succeeds.

The orchestrator does not implement step logic inline. For every agent-backed stage, it creates a specialist-agent invocation, writes the input prompt artifact, waits for the agent result, and reads only the declared output artifacts or `final-message.md`. The stage-specific prompt contract stays with that specialist invocation.

Harness is not an agent team architecture. There is no runtime protocol for direct inter-agent messaging, shared team rooms, peer chat, fan-out/fan-in discussion, or autonomous agent-to-agent handoff. Agent coordination happens through artifacts on disk and workflow dependencies.

## Producer-Reviewer Gates

Team-like review is modeled explicitly as another workflow step.

For example, the ChangeSet work-item workflow now uses this order:

```text
plan-work-item
-> review-work-item-plan
-> execute-work-item
-> verify-work-item
```

The reviewer reads the produced artifact and writes a review report. The report must contain `Review Status: approved` for downstream execution to continue. Any other status blocks the workflow before the executor runs.

This pattern can also be used for other critical artifacts, including `technical-decisions.md`, by adding a reviewer step with:

- an artifact-specific input list
- a review output under `.harness/runs/<RUN-ID>/...`
- `metadata.review_gate.output`
- `metadata.review_gate.status_label`
- `metadata.review_gate.approved_status`

## Correct Terminology

Use these terms:

- agent-backed sequential workflow
- pipeline orchestrator
- specialist agent per step
- explicit producer-reviewer gate
- artifact-mediated handoff

Avoid terms that imply agents can communicate directly unless the runtime has a concrete protocol for that behavior.
