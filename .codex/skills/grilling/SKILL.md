---
name: grilling
description: Stress-test a plan or design through one focused question at a time. Use when requirements, tradeoffs, or assumptions need deliberate stakeholder validation.
---

# grilling

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`grilling` stress-tests a plan or design one decision at a time.

It asks one question at a time, includes a recommended answer, and waits for the response before moving on. It does not ask for facts the codebase or documents can already settle.

Ask about unresolved business rules and consequential technology, architecture, integration, or data-transfer protocol choices. Resolve routine implementation and codebase details from the repository and settled decisions; ask only if a material user-visible consequence, compatibility constraint, irreversible effect, or unresolved conflict requires the user's choice. Honor explicit delegation and do not repeatedly ask the user to defend a delegated implementation choice.

## Ask questions the user can answer

Treat each question as if the user has not followed the agent's private reasoning. State the decision being made and the relevant situation in plain language; do not rely on unexplained project terms, prior turns, or findings the user has not seen. Briefly explain why the decision matters and what choosing an option would change. Expand a question when needed for clarity, while keeping it about one decision.

Name concrete options and their practical consequences. Include a recommended option and a short reason for the recommendation. Avoid cryptic shorthand, unexplained labels, and options that differ only in wording. If a term is necessary, define it in the question.

For example, instead of asking “Keep the snapshot or regenerate it?”, explain what the snapshot records, why it may be stale, and what each choice means for this change.

## When to reach for it

Use `/grilling` when you want to pressure-test a plan, design, or idea before building it.


## Exec 호출의 질문 전달

사용자 결정이 필요한 실행은 [질문 스키마](../../../.codex/internal-skills/skill-execution/schemas/question.schema.json)에 따라 질문을 결과의 `details.question`에 넣고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문 내용과 순서는 이 skill이 결정한다. 메인 orchestrator가 사용자에게 제시하고 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어간다. checkpoint와 이미 확정된 답변을 결과 파일에 보존한다.
