---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then recommend to-ticket without jumping to implementation.
---

# spec-me

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then recommends `to-ticket`.

요청별 workflow의 생성·단계 구성은 [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 맡고 메인 orchestrator의 시작 hook에서 호출한다. `spec-me`는 그 결과로 선택된 Spec 작성 범위를 수행한다. 다른 단계나 추가 reviewer가 필요하면 공통 상태 코드로 반환한다.

Standalone `spec-me` uses the model ID and reasoning effort resolved from `agents.high_performance_model` and `agents.high_performance_reasoning_effort`. An orchestrator-managed stage uses its supplied stage binding instead. The skill cannot change the model of an already-running invocation.

`spec_document_writer` owns Spec Markdown and `diagram_creator` owns diagram files. `execution_id`를 받은 skill은 필요한 작성·다이어그램·리뷰 작업을 파일에 기록하고 `SUBTASK_REQUIRED` 또는 `REVIEW_REQUIRED`로 반환한다. orchestrator가 fresh 작업을 호출하며 model·effort는 [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)가 설정에서 선택한다.

내부 작업 요청은 `required_subtasks`에 실행 가능한 `skill`, 선택적 `role`, 구체적 `purpose`를 기록한다. 재개 시 `context.previous_result_ref`의 checkpoint와 `context.subtask_result_ref`, `context.completed_subtasks`의 검증된 결과를 읽고 현재 범위와 시점에 유효한 완료 작업과 사용자 결정을 반복하지 않는다. 후속 내부 작업은 결과를 확인한 뒤 별도 요청한다.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 전달한 `context.worktree_ref`의 `worktree.json`을 읽고 `workspace`를 `session_worktree`로 사용한다. 신규 worktree를 생성하지 않는다. `workspace_root`와 모든 명령의 cwd는 이 준비된 worktree다. 실행 결과와 임시 파일에는 정본의 `session_directory`를 사용하고 `harness-session-output`이나 `.git` 경로를 다시 계산하지 않는다. standalone 요청도 먼저 메인 orchestrator의 workflow-compose 준비를 거친다. 구현 중 설계 변경은 caller 소유의 같은 worktree를 사용한다. 진입 preflight는 전달된 worktree에서 수행한다.
2. [Product Spec 절차](../../../.codex/internal-skills/product-spec/GUIDE.md)와 [Architecture 결정 단계](references/architecture-decision.md)를 순서대로 진행하며, 리뷰 시점과 gate는 [적대적 Spec 리뷰](references/adversarial-spec-review.md)를 따른다.
3. 리뷰와 완료 gate를 통과한 Specs와 근거를 작업 branch에 보존한다. 신규 Spec 요청은 같은 worktree를 [`to-ticket`](../to-ticket/SKILL.md)에 넘긴다. 구현 중 설계 변경은 변경 Spec·결정·영향 요구 ID를 상위 구현 caller에 반환한다. caller는 영향 계획의 갱신과 리뷰를 `to-ticket`에 인계하고 승인 근거를 받은 뒤 보존한 fixed point에서 구현을 재개한다.
## Documents

- Create `docs/specs/<plan-set-id>/` when missing. Product Spec은 `docs/specs/<plan-set-id>/product-spec.md`, Architecture Spec은 `docs/specs/<plan-set-id>/architecture-spec.md`에 둔다.
- Spec artifacts use the selected `session_worktree`. Before accepting any writer/diagram result, verify every output resolves inside that directory. New Spec sessions preserve artifacts on the session branch until integration; design changes during implementation use the caller-owned workspace and return their approved artifacts to that caller.
- Resolve the source tracker ticket before writing the Specs. Read the `plan_set_id` created during workflow composition from the canonical `worktree.json` and use it for Spec, diagram, decision, plan, review, and handoff paths. Preserve it for the same plan set; do not regenerate or rename it.
- Do not overwrite an existing Spec without explicit user approval.

## Rules

- When the request or confirmed interview answers contain reusable implementation-only or test-running preferences, pass the absolute original-project `shared_guidance_root` (`return_root`) and update its `docs/agents/implementation-guidance.md` or `testing-guidance.md` through the matching [implementation guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) or [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md). Verify it shares the same Git common directory as `workspace_root`. Keep inferred preferences, ticket-specific behavior, and unsettled architecture choices out of durable guidance.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 기준 계약

Spec 설계 전에 대상 프로젝트의 `docs/contracts/` 계약과 연결 다이어그램을 읽고 현재 구현 기준으로 참고한다. 제안하는 변경은 ticket-scoped Spec에 기록한다. 통합 계약 갱신은 구현 ticket 통합이 끝난 최종 구현 완료 단계에서 수행한다.

## 세션 출력

workflow 실행의 `session_directory`는 현재 작업을 위해 준비된 worktree의 canonical session이며 실행 결과·리뷰 증거·임시 산출물의 기준이다. `context.control_session_directory`는 orchestrator workflow 상태용으로만 사용한다. 두 경로를 서로 대체하거나 `.git` 아래에서 다시 계산하지 않는다. Spec과 다이어그램은 준비된 worktree의 선언 경로에 기록한다.


## Exec 호출의 질문 전달

사용자 결정이 필요한 실행은 [질문 스키마](../../../.codex/internal-skills/skill-execution/schemas/question.schema.json)에 따라 질문을 결과의 `question`에 넣고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문 내용과 순서는 이 skill이 결정한다. 메인 orchestrator가 사용자에게 제시하고 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어간다. checkpoint와 이미 확정된 답변을 결과 파일에 보존한다.
