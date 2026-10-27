---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

요청별 workflow의 생성·단계 구성은 [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 맡고 메인 orchestrator의 시작 hook에서 호출한다. `spec-me`는 그 결과로 선택된 Spec 작성 범위를 수행한다. 다른 단계나 추가 reviewer가 필요하면 공통 상태 코드로 반환한다.

Standalone `spec-me` uses the model ID and reasoning effort resolved from `agents.high_performance_model` and `agents.high_performance_reasoning_effort`. An orchestrator-managed stage uses its supplied stage binding instead. The skill cannot change the model of an already-running invocation.

`spec_document_writer` owns Spec Markdown and `diagram_creator` owns diagram files. `execution_id`를 받은 skill은 필요한 작성·다이어그램·리뷰 작업을 파일에 기록하고 `SUBTASK_REQUIRED` 또는 `REVIEW_REQUIRED`로 반환한다. orchestrator가 해당 stage의 model·effort를 resolve하여 fresh subagent를 호출한다. standalone 호출의 직접 spawn도 `agents.low_performance_model`과 `agents.low_performance_reasoning_effort`의 실제 값을 사용하며 config key 문자열이나 부모 모델 상속으로 대체하지 않는다.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 준비한 `worktree.json`을 읽고 `workspace`를 `session_worktree`로 사용한다. 신규 worktree를 생성하지 않는다. standalone 요청도 먼저 메인 orchestrator의 workflow-compose 준비를 거친다. 구현 중 설계 변경은 caller 소유의 같은 worktree를 사용한다. 이후 단계와 agent에는 파일의 `workspace`를 절대 `workspace_root`와 `cwd`로, `session_directory`를 session 경로로 전달한다. 진입 preflight는 전달된 위치에서 수행한다.
2. [Product Spec 절차](../../../.codex/internal-skills/product-spec/GUIDE.md)와 [Architecture 결정 단계](references/architecture-decision.md)를 순서대로 진행하며, 리뷰 시점과 gate는 [적대적 Spec 리뷰](references/adversarial-spec-review.md)를 따른다.
3. 리뷰와 완료 gate를 통과한 Specs와 근거를 작업 branch에 보존한다. 신규 Spec 요청은 같은 worktree를 [`to-ticket`](../to-ticket/SKILL.md)에 넘긴다. 구현 중 설계 변경은 변경 Spec·결정·영향 요구 ID를 상위 구현 caller에 반환한다. caller는 영향 계획의 갱신과 리뷰를 `to-ticket`에 인계하고 승인 근거를 받은 뒤 보존한 fixed point에서 구현을 재개한다.
## Documents

- Create `docs/specs/<ticket-id>/` when missing.
- Spec artifacts use the selected `session_worktree`. Before accepting any writer/diagram result, verify every output resolves inside that directory. New Spec sessions preserve artifacts on the session branch until integration; design changes during implementation use the caller-owned workspace and return their approved artifacts to that caller.
- Resolve the ticket ID before writing the specs.
- Do not overwrite an existing ticket-scoped spec without explicit user approval.

## Rules

- When the request or confirmed interview answers contain reusable implementation-only or test-running preferences, pass the absolute original-project `shared_guidance_root` (`return_root`) and update its `docs/agents/implementation-guidance.md` or `testing-guidance.md` through the matching [implementation guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) or [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md). Verify it shares the same Git common directory as `workspace_root`. Keep inferred preferences, ticket-specific behavior, and unsettled architecture choices out of durable guidance.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 기준 계약

Spec 설계 전에 대상 프로젝트의 `docs/contracts/` 계약과 연결 다이어그램을 읽고 현재 구현 기준으로 참고한다. 제안하는 변경은 ticket-scoped Spec에 기록한다. 통합 계약 갱신은 구현 ticket 통합이 끝난 최종 구현 완료 단계에서 수행한다.

## 세션 출력

`node .codex/scripts/harness-session-output.mjs --root <workspace_root>`로 `session_directory`를 구해 agent와 tool에 전달한다. 리뷰 증거와 임시 산출물은 그 경로에, Spec과 다이어그램은 선언된 프로젝트 경로에 기록한다.


## Exec 호출의 질문 전달

사용자 결정이 필요한 실행은 [공통 질문·답변 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md#질문과-답변)에 따라 질문 하나를 파일에 저장하고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문 내용과 순서는 이 skill이 결정한다. 메인 orchestrator가 사용자에게 제시하고 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어간다. checkpoint와 이미 확정된 답변을 결과 파일에 보존한다.
