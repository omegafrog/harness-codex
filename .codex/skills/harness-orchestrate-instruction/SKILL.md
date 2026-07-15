---
name: harness-orchestrate-instruction
description: 사용자가 명시적으로 호출하거나 모델이 구현 요청을 감지했을 때 feature·bugfix·refactor ChangeSet을 라우팅한다.
---

# Harness Orchestration

사용자·모델 진입점(L1).

1. `orchestration` agent를 호출해 intent와 현재 gate를 결정한다.
2. 직접 step을 수행하거나 하위 skill을 선택하지 않는다.
3. agent가 결과에 따라 적절한 L2 step을 호출해 라우팅한다.
4. 새 ChangeSet은 workspace L2가 만든 sibling worktree에서만 진행한다.
5. 사용자 질문, 차단, PR 생성에서 종료한다.
6. 각 skill 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
