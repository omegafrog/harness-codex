---
name: harness-orchestrate-instruction
description: Hand a single user instruction or failed runtime step to the harness workflow orchestration surface instead of manually slicing the request into staged commands. Use when the user asks to give only an initial instruction to an orchestration agent, let the orchestrator decide routing, avoid the main agent manually running requirements/use-case/plan/implementation steps, or route a failed work item through a runtime-owned orchestration decision.
---

# Harness Orchestrate Instruction

## Purpose

Use this skill to keep the main agent out of manual stage routing. The main agent packages the user's latest instruction, applies repository guardrails, then delegates to the harness orchestration surface when one exists.

The same skill is also used when the runtime invokes `workflow_orchestrator` from a workflow step. In that mode, the orchestration agent is the progress manager for the failed handoff: it reads the runtime failure context, decides whether control may return to the declared runtime route, emits a decision artifact, and exits so the Python runtime can perform the next transition.

## Hard Rules

- Do not decompose the request into `requirements-definition`, `use-case-definition`, `event-storming`, `ddd-design`, `technical-decisions`, `plan-writing`, `implementation`, or ad hoc command chains yourself.
- Do not execute product code changes directly.
- Do not silently fall back to manual staged workflow commands.
- Starting a new ChangeSet with `./harness requirements-definition --title ... --idea ...` is allowed for a new product, bug, or engineering instruction. It is the runtime's official entrypoint, not manual stage slicing.
- Do not publish ChangeSet-specific artifacts to `origin/main`.
- Preserve secrets. Do not echo user-provided keys.
- Keep the original user instruction intact; add only repository guardrails and known runtime constraints.
- When running as a workflow failure router, do not repair code, weaken verification, rewrite upstream design, or bypass gates. Emit a routing decision and return control to the runtime.

## Workflow

1. Capture the latest user instruction verbatim.
2. Inspect only minimal context:
   - `AGENTS.md`
   - `.harness/docs/agent/commands.md` when command discovery is needed
   - `./harness help` or `./harness help orchestrate` if an orchestration command may exist
3. Find an orchestration surface in this order:
   - callable `workflow_orchestrator` or equivalent orchestration agent
   - callable generic sub-agent support such as `multi_agent_v1.spawn_agent` with `agent_type: "default"`
   - `./harness orchestrate ...` if the runtime command exists
   - `./harness requirements-definition --title ... --idea ...` when there is no active ChangeSet and the instruction describes a new product, bug, or engineering request
   - active ChangeSet continuation only when the instruction already names a ChangeSet or the runtime reports one unambiguous active ChangeSet
4. If an orchestration surface exists, hand off the packet below and let it route.
5. If only generic sub-agent support exists, spawn one default agent with the handoff packet and this instruction: "Act as the workflow orchestration delegate. Select the harness runtime route yourself and execute or report blockers. Do not ask the caller to manually choose stages."
6. If no orchestration surface exists, stop and report this blocker: `free-form instruction orchestration surface missing`. Do not invent a manual stage sequence.

## Runtime Route Selection

- New product, bug, or engineering request with no active ChangeSet:
  - Run `./harness requirements-definition --title "<short title>" --idea "<verbatim instruction or concise issue summary>"`.
  - Let the runtime create/finalize the ChangeSet and report the next runtime action.
- Existing named ChangeSet:
  - Run the runtime continuation path for that ChangeSet, usually `./harness changes continue <CHG-ID> --apply`.
- One unambiguous active ChangeSet:
  - Continue it through the runtime.
- Multiple possible ChangeSets or unclear target:
  - Ask one concise Korean clarification question.

Do not treat absence of `./harness orchestrate` as a blocker when `requirements-definition` can start the runtime workflow.

## Workflow Failure Router Mode

When the current execution payload has `step.metadata.runtime_role = "failure_router"`, switch from initial-instruction routing to failure routing.

Required behavior:

1. Read `runtime_metadata.runtime_failed_step_id`, `runtime_metadata.runtime_failure_kind`, `runtime_metadata.runtime_failure_error`, and `runtime_metadata.runtime_failure_metadata` from the current execution payload.
2. Classify ownership:
   - implementation defect or security review rejection -> route to the declared `loop_target`, usually `plan-work-item`.
   - scope conflict -> block unless the runtime metadata clearly says the plan can be narrowed without changing ChangeSet scope.
   - upstream design, unclear E2E goal, document delta conflict, unclear verification goal, or environment blocker -> block and name the required upstream owner.
3. Emit a concise decision artifact in the final response. If `routing_contract.decision_output` is declared, write the same Markdown there. If that path cannot be written, return `Route Status: blocked` and explain the output-write blocker.
4. Do not spawn implementation, planner, verifier, git, or shell sub-work yourself. A successful failure-router result only authorizes the Python runtime to perform the next declared transition.
5. If blocking, state the blocker and required owner. Do not pretend the route succeeded.

Decision artifact format:

```markdown
# Orchestration Decision

- Route Status: route-to-loop-target | blocked
- Selected Route: <loop_target or owner/blocker>
- Failed Step: <runtime_failed_step_id>
- Failure Kind: <runtime_failure_kind>
- Reason: <one-line reason>
- Required Next Owner: workflow-runtime | implementation-planner | change-set-owner | upstream-design | environment
- Evidence:
  - <path or compact metadata key>
```

## Handoff Packet

Pass this shape to the orchestrator:

```text
Initial instruction:
<verbatim latest user instruction>

Repository guardrails:
- Follow AGENTS.md.
- Keep ChangeSet-specific artifacts off origin/main unless explicitly requested.
- Use runtime orchestration; do not ask the caller to choose stages unless genuinely ambiguous.
- Produce verification and report evidence when implementation, deployment, or testing is requested.
- Preserve secrets and local-only credential files.
- If no active ChangeSet exists and the instruction is a new request, start with `./harness requirements-definition --title ... --idea ...`.

Expected output:
- selected route
- commands/actions run by orchestrator
- verification result
- changed files
- commit/PR/deployment/report status when applicable
- blockers, if any
```

## Generic Sub-Agent Handoff

When `workflow_orchestrator` is not callable but `multi_agent_v1.spawn_agent` is available, use:

```json
{
  "agent_type": "default",
  "message": "<handoff packet plus: Act as the workflow orchestration delegate. Select the harness runtime route yourself and execute or report blockers. Do not ask the caller to manually choose stages.>"
}
```

This is still instruction-only orchestration. The main agent does not choose the stage sequence.

## Allowed Fallback

Only when the user explicitly allows fallback, use the nearest existing runtime continuation command:

- `./harness changes continue <CHG-ID> --apply`
- `./harness implementation <CHG-ID> --apply`

State that this fallback is staged runtime orchestration, not instruction-only orchestration.
