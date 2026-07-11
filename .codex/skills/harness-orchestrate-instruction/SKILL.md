---
name: harness-orchestrate-instruction
description: Hand a user instruction to the harness workflow orchestration surface instead of manually slicing the request into staged commands. Use when the user wants the orchestrator to decide workflow progression, routing, retries, remediation, or subagent selection.
---

# Harness Orchestrate Instruction

## Purpose

Use this skill to keep the main agent and Python runtime out of workflow-brain decisions. The orchestration agent owns route selection, retry/remediation decisions, and subagent selection. Runtime services provide local capabilities and verdicts only.

Runtime may expose local services such as worktree setup, artifact directories, schema/gate validation, dashboard projection, memory, observability, shell execution, and app/server lifecycle commands. Runtime must not decide the next workflow route after a failed or blocked step.

공개 workflow 진입점은 `harness orchestrate TEXT`입니다. `harness resume RUN-ID`는 동일한 durable orchestration session으로 재진입합니다. `.harness/orchestration/<session-id>/checkpoint.json`과 `session.lock`을 먼저 확인하고, terminal session은 replay하며 running session은 중복 실행하지 않습니다. Runtime state는 `.harness/state/changesets/<CHG-ID>/state.xml`만 읽습니다. `state.json`과 `.-harness-worktrees/**`는 읽거나 만들지 않습니다. Runtime utility는 `configure_runtime(repo_root).registry`와 기존 runtime-tool XML contract를 사용합니다.

## Hard Rules

- Do not decompose the request into `requirements-definition`, `use-case-definition`, `event-storming`, `ddd-design`, `technical-decisions`, `plan-writing`, `implementation`, or ad hoc command chains yourself when an orchestration surface is available.
- Do not rely on runtime routing fields or verifier-provided repair targets.
- Gate/verifier output is verdict-only: `pass|fail|blocked`, `rule_id`, `reason`, `evidence_path`, and `violations`.
- The orchestration agent decides the next subagent invocation after every subagent result.
- Every orchestration session has one current artifact namespace: `current_artifact_run_id` from the handoff. New sessions must not read prior sessions' `.harness/runs/**` verdicts as current state.
- The runtime pre-creates `current_artifact_run_dir`; treat that absolute directory as the only run-artifact root. Never search or read another `.harness/runs/<RUN-ID>` directory.
- orchestration agent가 native subagent capability를 직접 호출한다. Python runtime과 runtime service는 subagent를 생성하거나 실행하지 않는다.
- A subagent executes only the task assigned by the orchestrator and returns a result. It must not choose the next route.
- Orchestrator must not implement code, execute plan tasks, perform reviewer verification, or run workflow step commands directly.
- Declared `kind: validator` commands are deterministic runtime operations, not specialist work. The orchestrator must request the exact validator command through the runtime shell/tool service, read its verdict/artifact, and never let runtime choose the next route.
- After `review-work-item-plan` succeeds, materialize the declared `materialize-execution-scope` command before invoking `implementation_executor`; missing `execution-scope.xml` is a validator execution failure, not permission to skip the validator.
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
6. Build the existing `subagent-invocation.xml` at `.harness/runs/<RUN-ID>/steps/<STEP-ID>/subagent-invocation.xml`, validated by `subagent-invocation-v1.xsd`, with identity, delegate, instruction, input artifact hashes, and the matching step result path.
7. Call one native subagent session directly. Do not route this call through Python runtime.
8. Read only the matching `.harness/runs/<RUN-ID>/steps/<STEP-ID>/subagent-result.xml`, validated by `subagent-result-v1.xsd`, and any runtime gate/verifier verdict.
9. End delegated specialist session after result return. Do not create substitute result content.
10. Decide one of:
   - continue with another subagent invocation
   - block with the required owner/reason
   - complete and summarize evidence

## Review rejection remediation

- `Review Status: rejected` from `review-work-item-plan` is a remediation signal, not a terminal route by itself.
- Read the rejected plan, review artifact, active ChangeSet, maintenance slice, and approved technical decisions. Compare the finding to the upstream canonical direction.
- When the upstream artifacts are internally consistent and the plan is wrong, invoke the same `plan-work-item` specialist again with a bounded repair instruction. Include the review artifact as input, name the conflicting plan section, and require preservation of unrelated approved content.
- Re-run `review-work-item-plan` after the repaired plan. Do not run `materialize-execution-scope` or implementation before approval.
- When upstream artifacts themselves conflict or a policy answer is absent, route to the owning upstream stage. Do not rewrite ChangeSet intent to make a plan pass.
- Only return `blocked` after the owning upstream route is unavailable, required approval/input is absent, or the bounded remediation attempts are exhausted. Report the exact owner and evidence.
- Before using any review, gate, execution-scope, verification, or subagent-result artifact, verify it belongs to `current_artifact_run_id` and its declared input hashes match current source. A stale artifact is a producer rerun condition, not a route verdict.
- Invocation/result XML is step-scoped. A result from another `step_id`, even inside the same run, is a contract failure; never treat it as the current specialist result.
- Native specialist wait is bounded by the orchestration timeout. On timeout, terminate the specialist and child process, record provider timeout, and stop; do not wait indefinitely or synthesize `subagent-result.xml`.
- A response to a single user question is scoped to that question. It must not be treated as approval to change unrelated requirements or maintenance behavior.

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
  "agent_type": "<selected agent_id>",
  "message": "<handoff packet: identity, delegate, instruction, artifact hashes, result path, reviewTask>"
}
```

호출 규칙:

- `message` 또는 `items` 중 하나만 사용한다. 위 specialist handoff는 plain `message`로 보낸다.
- `fork_context: true`를 사용할 때는 `agent_type`, `model`, `reasoning_effort`, `service_tier`를 함께 보내지 않는다. specialist 호출에는 full-history fork를 사용하지 않고 위 payload만 보낸다.
- `spawn_agent`가 받지 않는 필드나 중첩 `items`를 임의로 추가하지 않는다. 호출 실패 시 payload를 바꿔 반복하지 말고, 동일 계약으로 한 번만 재시도한 뒤 블로킹한다.

main agent와 Python runtime은 stage sequence를 선택하거나 subagent를 실행하지 않는다. handoff와 route 책임은 orchestration agent에 있다.
