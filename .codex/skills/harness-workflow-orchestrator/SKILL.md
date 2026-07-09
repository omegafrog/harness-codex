---
name: harness-workflow-orchestrator
description: Decide the next workflow step only for BLOCKED outcomes or verification FAILED outcomes, then write the fixed XML orchestration-decision handoff.
---

# Harness Workflow Orchestrator

## Purpose

Use this skill only for a `runtime_handoff_only` workflow step invoked by `RunnerEngine` after another step returns `BLOCKED`, or after a verification step returns `FAILED`.

This is not normal-path routing and it is not direct agent-to-agent messaging. The orchestrator receives failure context through runtime metadata and writes one disk artifact. `RunnerEngine` reads that artifact and resumes only if the selected target is an existing workflow step id and is not downstream of the blocked/failed step.

`orchestrate-blocker` is a runtime recovery hook. It is listed in the workflow graph only so the engine can discover the recovery hook attached to the failed step. It must not run during the happy path.

## Hard Rules

- Do not route every workflow step. Normal successful steps continue by graph order without orchestration.
- Do not handle ordinary non-verification `FAILED` steps as recoverable routing decisions. Those are terminal engine failures unless the failed result is converted into `BLOCKED` by a structured contract.
- Do not route to workflow steps after the blocked/failed source step. Downstream steps have not proven safe yet.
- You may route to an earlier repair/replan boundary, the failed step itself, or a runtime remediation hook whose `loop_target` is earlier than or equal to the blocked/failed step.
- Prefer partial repair. Do not regenerate whole downstream artifacts when the blocker can be solved by updating a narrower upstream artifact.
- Do not edit product code, plans, ChangeSets, design documents, verifier reports, review reports, or runtime source files during this handoff.
- Do not invent workflow step ids. `target_step` must be copied from the materialized workflow graph.
- Do not return Markdown as the canonical decision. Markdown final output is only a human summary.
- The canonical output is exactly one XML file at the runtime-declared output path.
- Use `status="route"` only when a concrete next workflow step can safely handle the blocker or verification failure.
- Use `status="pause"` when the blocker requires user/product/design/environment input or no safe step exists.
- Preserve unrelated worktree changes and secrets.

## Required Inputs To Inspect

Read the runtime prompt/invocation context and inspect only the files needed to decide the route:

- failed/blocked step id
- step status: `BLOCKED` or verification `FAILED`
- `runtime_failure_kind`
- `runtime_failure_error`
- `runtime_failure_metadata`
- `runtime_retry_count`
- workflow step list and step ids
- workflow order of the failed/blocked step
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
- `failed_step_id`: blocked source step id or failed verification step id
- `failure_kind`: runtime failure kind, or empty string when absent
- `reason`: concise reason for the decision
- `retry_allowed`: boolean

Optional evidence fields are allowed, such as `route_code`, `block_code`, `source_report`, `evidence`, `repair_scope`, and `expected_partial_change`.

## Routing Guide

Prefer the smallest safe upstream workflow step:

- Verification implementation/test/security implementation defects: route to the smallest earlier repair/replan boundary. Use a runtime remediation hook such as `prepare-plan-repair` only when its `loop_target` is earlier than or equal to the failed verification step.
- Plan review rejection or plan contradiction reported as `BLOCKED`: route to `plan-work-item`.
- Execution scope materialization or scope conflict reported as `BLOCKED`: route to `plan-work-item` unless the ChangeSet scope itself is wrong, then pause.
- Missing active ChangeSet, missing work item slice, unclear product decision, upstream design conflict, unclear verification goal, or environment blocker: pause with a concrete reason.
- Unknown route code: pause unless an existing upstream step is clearly responsible.

Do not route to completion/finalization/reporting steps after the blocked/failed step. The engine will reject downstream targets.

## Final Response

After writing the XML file, briefly report:

- `status`
- `target_step`
- reason
- expected partial repair scope
- XML path
- blocker if paused
