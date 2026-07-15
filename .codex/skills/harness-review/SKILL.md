---
name: harness-review
description: orchestrator가 모든 plan 작업이 완료된 work item의 구현 gate를 검토할 때 호출한다.
---

# Review

레벨: L2.

`reviewer` sub-agent를 spawn한다. 정본 지침은 `.codex/agents/references/reviewer.md`다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. review 문서, workflow 산출물, 코드, commit message에는 적용하지 않는다.

메인 에이전트는 입력 범위와 정본 지침 경로를 전달하고, 구현 gate 검토를 직접 수행하지 않는다. sub-agent 결과를 검토 결과로 통합한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
