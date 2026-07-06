---
name: harness-orchestrate-instruction
description: Hand a single user instruction to the harness workflow orchestration surface instead of manually slicing the request into staged commands. Use when the user asks to give only an initial instruction to an orchestration agent, let the orchestrator decide routing, or avoid the main agent manually running requirements/use-case/plan/implementation steps.
---

# Harness Orchestrate Instruction

## Purpose

Use this skill to keep the main agent out of manual stage routing. The main agent packages the user's latest instruction, applies repository guardrails, then delegates to the harness orchestration surface when one exists.

## Hard Rules

- Do not decompose the request into `requirements-definition`, `use-case-definition`, `event-storming`, `ddd-design`, `technical-decisions`, `plan-writing`, `implementation`, or ad hoc command chains yourself.
- Do not execute product code changes directly.
- Do not silently fall back to manual staged workflow commands.
- Do not publish ChangeSet-specific artifacts to `origin/main`.
- Preserve secrets. Do not echo user-provided keys.
- Keep the original user instruction intact; add only repository guardrails and known runtime constraints.

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
   - active ChangeSet continuation only when the instruction already names a ChangeSet or the runtime reports one unambiguous active ChangeSet
4. If an orchestration surface exists, hand off the packet below and let it route.
5. If only generic sub-agent support exists, spawn one default agent with the handoff packet and this instruction: "Act as the workflow orchestration delegate. Select the harness runtime route yourself and execute or report blockers. Do not ask the caller to manually choose stages."
6. If no orchestration surface exists, stop and report this blocker: `free-form instruction orchestration surface missing`. Do not invent a manual stage sequence.

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
