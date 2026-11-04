---
name: spec-me
description: Turn a user request into Product Spec and Architecture Spec, then complete the specification stage without jumping to implementation.
---

# spec-me

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 필요한 내부 작업을 서브에이전트에 위임하고 결과 파일과 공통 envelope를 반환한다. 사용자 결정과 workflow 단계 전환은 orchestrator에 반환한다.

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec, then completes its stage. The orchestrator selects `to-ticket` as a separate next stage when the requested workflow includes planning.

요청별 workflow의 생성·단계 구성은 [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 맡고 메인 orchestrator의 시작 hook에서 호출한다. `spec-me`는 그 결과로 선택된 Spec 작성 범위를 수행하고 다른 workflow 단계가 필요하면 공통 상태 코드로 반환한다.

Standalone `spec-me` uses the model ID and reasoning effort resolved from `agents.high_performance_model` and `agents.high_performance_reasoning_effort`. An orchestrator-managed stage uses its supplied stage binding instead. The skill cannot change the model of an already-running invocation.

`spec-me`가 Product·Architecture Spec Markdown을 작성하고 수정한다. `diagram_creator`는 다이어그램 파일을 작성한다. 확정된 결정과 근거를 반영해 각 Spec template과 topics의 모든 항목을 작성하고, 미확정 결정은 사용자에게 질문한다. 작성 과정과 실행 내역은 일반 실행 로그에 남긴다.

## Spec 작성과 수정

사용자 원문과 확정 답변을 `docs/specs/<plan-set-id>/request.md`에 보존하고 Product 결정은 `product-decisions.md`에 기록한다. Product 결정이 바뀌면 결정 기록과 Product Spec을 함께 수정한다. 같은 workflow가 작성한 Spec은 리뷰 지적에 따라 수정할 수 있다. 기존에 사용자 또는 다른 workflow가 작성한 Spec을 교체할 때는 사용자 승인을 받는다.

Product와 Architecture 문서를 확정한 뒤 현재 두 문서를 대상으로 독립 리뷰를 실행한다. 리뷰 지적을 반영해 문서가 바뀌면 새 reviewer로 다시 검토한다. 현재 문서의 hash와 통과한 리뷰가 일치할 때만 `completed/OK`를 반환한다. 별도의 writer receipt나 writer 요청 envelope는 사용하지 않는다.

Architecture Spec 독립 리뷰는 `spec-me` 실행 안에서 fresh `spec_adversarial_reviewer` native subagent를 직접 호출하고 결과를 수집·수정·재검토한다. 이 작업을 `review_request.skill: spec-review`로 상위 orchestrator에 반환하지 않는다. 리뷰 준비가 불가능하면 실제 실패 사유를 반환하며 리뷰를 통과한 것으로 취급하지 않는다. 별도의 Architecture 결정 리뷰가 `review_request`를 필요로 하면 `context_path`는 Spec 디렉터리가 아닌 session 상대 JSON 파일이다.

내부 작업에는 실행할 skill 지침, `.codex/agents/<ID>.toml` 프로필과 구체적 목적을 전달한다. Product와 Architecture Spec 작성은 각각 해당 `product-spec` 및 `architecture-spec` 지침을 따른다. 재개 시 기존 작업과 확정된 결정을 재사용한다.

If the request is about broken behavior, flaky regression, or performance regression, `spec-me` is not the right on-ramp; use `diagnosing-bugs` instead.

## Flow

1. [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)가 전달한 `context.worktree_ref`의 `worktree.json`을 읽고 `workspace`를 `session_worktree`로 사용한다. 신규 worktree를 생성하지 않는다. `workspace_root`와 모든 명령의 cwd는 이 준비된 worktree다. 실행 결과와 임시 파일에는 정본의 `session_directory`를 사용하고 `harness-session-output`이나 `.git` 경로를 다시 계산하지 않는다. standalone 요청도 먼저 메인 orchestrator의 workflow-compose 준비를 거친다. 구현 중 설계 변경은 caller 소유의 같은 worktree를 사용한다. 진입 preflight는 전달된 worktree에서 수행한다.
2. [Product Spec 절차](../../../.codex/internal-skills/product-spec/GUIDE.md)와 [Architecture 결정 단계](references/architecture-decision.md)를 순서대로 진행하며, 리뷰 시점과 gate는 [적대적 Spec 리뷰](references/adversarial-spec-review.md)를 따른다.
3. 리뷰와 완료 gate를 통과한 Specs와 근거를 작업 branch에 보존한다. 신규 Spec 요청은 `completed/OK`로 반환한다. 다음 계획 stage 선택과 실행은 orchestrator가 사용자 요청 범위에 따라 결정한다. 구현 중 설계 변경은 변경 Spec·결정·영향 요구 ID를 상위 구현 caller에 반환한다. caller는 영향 계획의 갱신과 리뷰를 `to-ticket`에 인계하고 승인 근거를 받은 뒤 보존한 fixed point에서 구현을 재개한다.
## Documents

- Create `docs/specs/<plan-set-id>/` when missing. Product Spec은 `docs/specs/<plan-set-id>/product-spec.md`, Architecture Spec은 `docs/specs/<plan-set-id>/architecture-spec.md`에 둔다.
- Spec artifacts use the selected `session_worktree`. Before accepting any writer/diagram result, verify every output resolves inside that directory. New Spec sessions preserve artifacts on the session branch until integration; design changes during implementation use the caller-owned workspace and return their approved artifacts to that caller.
- Read the `plan_set_id` created during workflow composition from the canonical `worktree.json` and use it for Spec, diagram, decision, plan, review, and handoff paths. Preserve it for the same plan set; do not regenerate or rename it.
- Preserve an existing Spec owned by another workflow unless the user approves replacing it; revise the current workflow's own Spec when its review requires changes.

## Rules

- When the user explicitly states a reusable implementation-only or test-running preference in the request or confirmed interview answers, update `docs/agents/implementation-guidance.md` or `testing-guidance.md` inside the active `workspace_root` through the matching [implementation guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) or [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md). This keeps the memory change on the workflow branch so it can be reviewed and pushed with that workspace. Do not treat developer/skill instructions, inferred preferences, ticket-specific behavior, or unsettled architecture choices as durable guidance.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 기준 계약

Spec 설계 전에 대상 프로젝트의 `docs/contracts/` 계약과 연결 다이어그램을 읽고 현재 구현 기준으로 참고한다. 제안하는 변경은 ticket-scoped Spec에 기록한다. 통합 계약 갱신은 구현 ticket 통합이 끝난 최종 구현 완료 단계에서 수행한다.

유비쿼터스 언어는 plan set 산출물이 아니라 대상 프로젝트 전체의 공유 vocabulary다. Product Spec §4의 모든 도메인 용어와 Architecture 단계에서 새로 정하거나 의미를 바꾼 도메인 용어를 활성 `workspace_root/CONTEXT.md`에 추가·갱신한다. 기존 canonical 정의를 먼저 비교하고, 정의 변경·대체·폐기 lifecycle을 적용한다. 동일 의미 용어를 ticket마다 복제하거나 Spec 안에만 남기지 않는다. Bounded Context의 책임·관계는 `CONTEXT-MAP.md`에 갱신한다. framework, package, API identifier와 설명 문구는 도메인 용어가 아니면 glossary에 넣지 않는다.

## 세션 출력

workflow 실행의 `session_directory`는 현재 작업을 위해 준비된 worktree의 canonical session이며 실행 결과·리뷰 증거·임시 산출물의 기준이다. `context.control_session_directory`는 orchestrator workflow 상태용으로만 사용한다. 두 경로를 서로 대체하거나 `.git` 아래에서 다시 계산하지 않는다. Spec과 다이어그램은 준비된 worktree의 선언 경로에 기록한다.


## Exec 호출의 질문 전달

질문 전에 현재 workflow의 확정 답변과 `request.md`, `product-decisions.md`, 프로젝트의 승인된 결정·위임 범위를 확인한다. 같은 조건에서 이미 답했거나 명시적으로 위임된 선택은 근거와 함께 재사용한다. 남은 독립적인 필수 질문은 한 배열로 묶는다. 위임 범위를 벗어난 선택이나 승인되지 않은 추천은 사용자 답으로 기록하지 않는다.

질문을 반환한 execution의 `decision-answers.json`과 해당 `result.json`의 질문을 함께 확인한다. 재개 execution의 `answers.json`은 입력으로 받은 답변이며 이전 execution에 같은 이름의 파일이 있다고 추정하지 않는다. 사용자 결정은 장기 문서에도 내용과 출처를 보존하고, 참조 경로를 인용하기 전에 실제 존재를 확인한다.

사용자 결정이 필요한 실행은 [질문 스키마](../../../.codex/internal-skills/skill-execution/schemas/question.schema.json)에 따라 질문을 결과의 `questions` 배열에 넣고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문 한 개도 배열에 담는다. 질문 내용과 순서는 이 skill이 결정한다. 메인 orchestrator가 사용자에게 제시하고 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어간다. checkpoint와 이미 확정된 답변을 결과 파일에 보존한다. 질문 문장은 `title`에 기록한다. stage 내부에서 사용자 질문 도구를 직접 호출하지 않는다.
