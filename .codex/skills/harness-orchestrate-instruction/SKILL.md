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
- Do not rely on runtime routing fields or verifier-provided repair targets.
- Gate/verifier output is verdict-only: `pass|fail|blocked`, `rule_id`, `reason`, `evidence_path`, and `violations`.
- The orchestration agent decides the next subagent invocation after every subagent result.
- orchestration agent가 native subagent capability를 직접 호출한다. Python runtime과 runtime service는 subagent를 생성하거나 실행하지 않는다.
- A subagent executes only the task assigned by the orchestrator and returns a result. It must not choose the next route.
- Orchestrator must not implement code, execute plan tasks, perform reviewer verification, or run workflow step commands directly.
- Orchestrator reads workflow YAML, declared document artifacts, `needs`, and prior results; actual step work belongs to selected subagent.
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
4. Load the selected `agent_id` TOML and `skill_id` `SKILL.md`.
5. Check the selected step's declared `needs` against current workflow results.
6. Build existing `subagent-invocation.xml`, validated by `subagent-invocation-v1.xsd`, with identity, delegate, instruction, input artifact hashes, and result path.
7. Call one native subagent session directly. Do not route this call through Python runtime.
8. Read one existing `subagent-result.xml`, validated by `subagent-result-v1.xsd`, and any runtime gate/verifier verdict.
9. End delegated specialist session after result return. Do not create substitute result content.
10. Decide one of:
   - continue with another subagent invocation
   - block with the required owner/reason
   - complete and summarize evidence

## Native Subagent 계약

native subagent 호출에는 다음을 전달한다.

- `agent_id`: 기존 `.codex/agents/<agent_id>.toml` 파일명 stem.
- `skill_id`: 기존 `.codex/skills/<skill_id>/SKILL.md` directory.
- 선택한 workflow의 `step_id`와 `attempt_id`.
- route나 repair 판단을 추가하지 않은 task instruction.
- input artifact path와 SHA-256 값.
- 출력 `subagent-result.xml` path.

subagent 호출 전:

- agent config가 없거나 유효하지 않으면 거부한다.
- skill 파일이 없으면 거부한다.
- dependency 결과가 없거나 허용되지 않으면 거부한다.
- 선택한 agent가 reviewer이면 `reviewTask`로 reviewer 범위를 고정한다.

호출 후:

- 기존 `subagent-result-v1.xsd` result 하나를 요구한다. 기존 두 XML 계약 외 새 XML/XSD/report type을 만들지 않는다.
- identity, delegate, artifact hash, reviewer coverage를 검증한다.
- contract failure는 사실로 처리하며 runtime이 route를 선택하게 하지 않는다.
- retry, remediation, next step, completion은 orchestration agent가 직접 판단한다.

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
- runtime executes workflow step commands for orchestration agent
- runtime calls a workflow routing step
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

설정된 `workflow_orchestrator` session을 사용할 수 없지만 host가 `multi_agent_v1.spawn_agent` 같은 native generic sub-agent capability를 제공하면 orchestration agent가 해당 capability를 직접 호출한다.

```json
{
  "agent_type": "default",
  "message": "<handoff packet plus: Act as the workflow orchestration delegate. Select harness routes yourself, call subagents one step at a time, consume verdict-only runtime results, and report blockers. Do not ask the caller to manually choose stages.>"
}
```

main agent와 Python runtime은 stage sequence를 선택하거나 subagent를 실행하지 않는다. handoff와 route 책임은 orchestration agent에 있다.
