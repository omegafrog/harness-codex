---
name: harness-implementation-executor
description: ChangeSet 구현 계획의 첫 미완료 작업 하나를 구현하고 검증·체크·커밋하는 L2 step이다.
---

# Implementation Executor

레벨: L2.

`implementation_executor` agent를 호출한다. 정본 지침은
`.codex/agents/references/implementation_executor.md`다.

- `docs/changes/active/<CHG-ID>/plan.md`의 첫 `- [ ]` 작업 하나만 처리한다.
- 해당 작업의 검증이 통과했을 때만 같은 행을 `- [x]`로 바꾸고, ChangeSet 산출물은 stage하지 않은 채 선언된 제품 경로만 한국어 커밋을 만든다.
- 기술·도메인 결정이 비어 있거나 검증이 실패하면 체크·커밋하지 않고 blocker를 반환한다.
- Java 작업일 때만 `.codex/agents/references/effective-java.md`를 읽는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
