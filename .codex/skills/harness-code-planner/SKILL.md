---
name: harness-code-planner
description: orchestrator가 ready인 ChangeSet의 단일 active plan을 만들 때 호출한다.
---

# Plan

레벨: L2.

`implementation_planner` sub-agent를 spawn한다. agent의 정본 지침은
`.codex/agents/references/implementation_planner.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. active plan 산출 문서에는 적용하지 않고, 한국어 문서 품질과 템플릿 구조를 유지한다.

메인 에이전트는 ChangeSet 식별자와 계획 작성 범위를 전달하고, active plan 작성은 sub-agent가 수행한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
