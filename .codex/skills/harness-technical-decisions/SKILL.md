---
name: harness-technical-decisions
description: orchestrator가 통합 DDD architecture 또는 maintenance work item의 구현 차단 기술 결정을 확정할 때 호출한다.
---

# Technical Decisions

레벨: L2.

`technical_decisions` sub-agent를 spawn한다. agent의 정본 지침은
`.codex/agents/references/technical_decisions.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. technical decisions 산출 문서에는 적용하지 않고, 한국어 문서 품질과 템플릿 구조를 유지한다.

메인 에이전트는 대상 ChangeSet 또는 maintenance work item만 전달하고, 구현 차단 기술 결정은 sub-agent가 확정한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
