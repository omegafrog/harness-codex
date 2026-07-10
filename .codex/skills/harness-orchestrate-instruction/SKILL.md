---
name: harness-orchestrate-instruction
description: Hand a user instruction to the harness workflow orchestration surface instead of manually slicing the request into staged commands. Use when the user wants the orchestrator to decide workflow progression, routing, retries, remediation, or subagent selection.
---

# Harness Orchestrate Instruction

## Purpose

Use this skill to keep the main agent and Python runtime out of workflow-brain decisions. The orchestration agent owns route selection, retry/remediation decisions, and subagent selection. Runtime services provide local capabilities and verdicts only.

Runtime may expose local services such as worktree setup, artifact directories, schema/gate validation, dashboard projection, memory, observability, shell execution, and app/server lifecycle commands. Runtime must not decide the next workflow route after a failed or blocked step.

## Hard Rules

- Do not decompose the request into `requirements-definition`, `use-case-definition`, `event-storming`, `ddd-design`, `technical-decisions`, `plan-writing`, `implementation`, or ad hoc command chains yourself when an orchestration surface is available.
- Do not rely on a runtime failure-router step, `loop_target`, `owner_stage`, `recommended_resume_target`, or verifier-provided repair target.
- Gate/verifier output is verdict-only: `pass|fail|blocked`, `rule_id`, `reason`, `evidence_path`, and `violations`.
- The orchestration agent decides the next subagent invocation after every subagent result.
- A subagent executes exactly one selected step skill and returns a step result. It must not choose the next route.
- Do not publish ChangeSet-specific artifacts to `origin/main` unless explicitly requested.
- Preserve secrets. Do not echo user-provided keys.
- Keep the original user instruction intact; add only repository guardrails and known runtime constraints.

## Workflow Brain Loop

1. Capture the latest user instruction verbatim.
2. Inspect only minimal context:
   - `AGENTS.md`
   - `.harness/docs/agent/commands.md` when command discovery is needed
   - `./harness help` or `./harness help orchestrate` if an orchestration command may exist
3. Select the next route yourself as the orchestration agent.
4. Select one subagent/skill invocation.
5. Let that subagent execute only the selected step skill.
6. Read the subagent step result and any runtime gate/verifier verdict.
7. Decide one of:
   - continue with another subagent invocation
   - block with the required owner/reason
   - complete and summarize evidence

## Runtime Service Boundary

Allowed runtime calls:

- worktree creation and initialization
- runtime artifact directory preparation
- dashboard projection and dashboard UI
- XML schema validation
- static gate condition registration/update/execution
- memory lookup/write
- observability and metrics capture
- shell command execution
- dev/deploy server start, stop, health check

Forbidden runtime assumptions:

- runtime chooses workflow progression
- runtime chooses next step after failed/blocked result
- runtime chooses retry/remediation
- runtime calls a failure-router step
- verifier/gate chooses owner or resume target

## Handoff Packet

Pass this shape to the orchestrator:

```text
Initial instruction:
<verbatim latest user instruction>

Repository guardrails:
- Follow AGENTS.md.
- Keep ChangeSet-specific artifacts off origin/main unless explicitly requested.
- Use orchestration-agent workflow routing; do not ask the caller to choose stages unless genuinely ambiguous.
- Runtime services may validate schemas/gates and run local tools, but they must not choose the next route.
- Gate/verifier results are verdict-only and must not contain owner_stage, recommended_resume_target, retry target, or repair target.
- Produce verification and report evidence when implementation, deployment, or testing is requested.
- Preserve secrets and local-only credential files.

Expected output:
- selected route
- selected subagent/skill calls
- subagent step results
- gate/verifier verdicts
- verification result
- changed files
- commit/PR/deployment/report status when applicable
- blockers, if any
```

## Generic Sub-Agent Handoff

When `workflow_orchestrator` is not callable but generic sub-agent support such as `multi_agent_v1.spawn_agent` is available, use:

```json
{
  "agent_type": "default",
  "message": "<handoff packet plus: Act as the workflow orchestration delegate. Select harness routes yourself, call subagents one step at a time, consume verdict-only runtime results, and report blockers. Do not ask the caller to manually choose stages.>"
}
```

This is still instruction-only orchestration. The main agent and runtime do not choose the stage sequence.

## Allowed Fallback

Only when the user explicitly allows fallback, use the nearest existing runtime continuation command:

- `./harness changes continue <CHG-ID> --apply`
- `./harness implementation <CHG-ID> --apply`

State that this fallback is staged runtime execution, not orchestration-agent-owned routing.
