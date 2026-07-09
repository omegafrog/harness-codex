---
name: harness-workflow-orchestrator
description: Own harness workflow progression, decide the next safe step, and write the fixed XML orchestration-decision handoff.
---

# Harness Workflow Orchestrator

## Purpose

Use this skill when the runtime asks `workflow_orchestrator` to decide the next safe workflow step.

The orchestrator owns progression. `RunnerEngine` does not choose the next step and does not automatically walk the whole workflow. The engine executes one requested step, validates its command/output contract, records the result, and returns that result. The orchestrator then decides what happens next.

This is not direct agent-to-agent messaging. The canonical decision is a disk artifact: one fixed-schema `orchestration-decision` XML file. The runtime reads that file, validates the target, and executes only the selected step.

## Hard Rules

- You own workflow progression. Do not assume the engine will choose the next step for you.
- Do not route every normal success through repair logic. Successful steps may continue to the next safe workflow step.
- Do not handle ordinary non-verification `FAILED` steps as recoverable routing decisions unless the failed result is converted into `BLOCKED` by a structured contract.
- Do not route to normal workflow steps after the blocked/failed source step. Downstream steps have not proven safe yet.
- You may route to an earlier repair/replan boundary, the failed step itself, or a runtime remediation hook whose `loop_target` is earlier than or equal to the blocked/failed step.
- Prefer partial repair. Do not regenerate whole downstream artifacts when the blocker can be solved by updating a narrower upstream artifact.
- Do not edit product code, plans, ChangeSets, design documents, verifier reports, review reports, or runtime source files during routing.
- Do not invent workflow step ids. `target_step` must be copied from the materialized workflow graph.
- Do not return Markdown as the canonical decision. Markdown final output is only a human summary.
- The canonical output is exactly one XML file at the runtime-declared output path.
- Use `status="route"` only when a concrete next workflow step can safely handle the blocker or verification failure.
- Use `status="pause"` when the blocker requires user/product/design/environment input or no safe step exists.
- Preserve unrelated worktree changes and secrets.

## Mental Model

Read the runtime as this loop:

1. Inspect current workflow state.
2. Choose one step.
3. Let RunnerEngine execute that one step.
4. Inspect the StepResult.
5. Choose the next step, a repair boundary, or pause.

The engine is not the workflow manager. It is the execution boundary.

## Required Inputs To Inspect

Read the runtime prompt/invocation context and inspect only the files needed to decide the route:

- current workflow step list and step ids
- current completed step ids
- current step id, when provided
- failed/blocked step id, when provided
- step status: `BLOCKED` or verification `FAILED`, when provided
- `runtime_failure_kind`
- `runtime_failure_error`
- `runtime_failure_metadata`
- `runtime_retry_count`
- declared output path for the orchestration decision XML
- verifier/security XML reports when referenced by metadata

## XML Output Contract

Write a `harness-handoff` XML artifact with type `orchestration-decision` using the shared XML handoff format:

```xml
<?xml version='1.0' encoding='utf-8'?>
<harness-handoff xmlns="urn:harness:handoff:v1" schemaVersion="1" type="orchestration-decision">
  <data>
    <value kind="map">
      <entry key="schema_version"><value kind="integer">1</value></entry>
      <entry key="status"><value kind="string">route</value></entry>
      <entry key="target_step"><value kind="string">plan-work-item</value></entry>
      <entry key="failed_step_id"><value kind="string">verify-work-item</value></entry>
      <entry key="failure_kind"><value kind="string">implementation</value></entry>
      <entry key="reason"><value kind="string">Implementation verification failed; route to the smallest upstream repair boundary.</value></entry>
      <entry key="retry_allowed"><value kind="boolean">true</value></entry>
    </value>
  </data>
</harness-handoff>
```

Required fields:

- `schema_version`: integer `1`
- `status`: `route` or `pause`
- `target_step`: existing workflow step id when status is `route`; empty string when status is `pause`
- `failed_step_id`: blocked source step id or failed verification step id; empty string if this is a normal initial routing decision
- `failure_kind`: runtime failure kind, or empty string when absent
- `reason`: concise reason for the decision
- `retry_allowed`: boolean

Optional evidence fields are allowed, such as `route_code`, `block_code`, `source_report`, `evidence`, `repair_scope`, and `expected_partial_change`.

## Routing Guide

Prefer the smallest safe workflow step:

- Normal success: route to the next safe step whose prerequisites are satisfied.
- Verification implementation/test/security implementation defects: route to the smallest earlier repair/replan boundary. Use a runtime remediation hook such as `prepare-plan-repair` only when its `loop_target` is earlier than or equal to the failed verification step.
- Plan review rejection or plan contradiction reported as `BLOCKED`: route to `plan-work-item`.
- Execution scope materialization or scope conflict reported as `BLOCKED`: route to `plan-work-item` unless the ChangeSet scope itself is wrong, then pause.
- Missing active ChangeSet, missing work item slice, unclear product decision, upstream design conflict, unclear verification goal, or environment blocker: pause with a concrete reason.
- Unknown route code: pause unless an existing upstream step is clearly responsible.

Do not route to completion/finalization/reporting steps after the blocked/failed step. The runtime will reject downstream targets.

## Final Response

After writing the XML file, briefly report:

- `status`
- `target_step`
- reason
- expected partial repair scope
- XML path
- blocker if paused
