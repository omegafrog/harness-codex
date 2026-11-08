
# grilling

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

사용자 결정이 필요한 실행은 [질문 스키마](../../../.codex/internal-skills/skill-execution/schemas/question.schema.json)에 따라 질문을 결과의 `questions` 배열에 넣고 `action_required / USER_DECISION_REQUIRED`로 반환한다. 질문이 하나여도 배열에 담는다. 질문 내용과 순서는 이 skill이 결정한다. 메인 orchestrator가 사용자에게 제시하고 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어간다. checkpoint와 이미 확정된 답변을 결과 파일에 보존한다. 질문 문장은 `title`에 기록한다. stage 내부에서 사용자 질문 도구를 직접 호출하지 않는다.
