---
name: harness-review
description: orchestrator가 모든 plan 작업이 완료된 work item의 구현 gate를 검토할 때 호출한다.
---

# Review

레벨: L2.

`reviewer` sub-agent를 spawn한다. 정본 지침은 `.codex/agents/references/reviewer.md`다.

같은 ChangeSet·artifact revision의 reviewer lease가 있으면 `followup_task`로 재사용한다. 독립 reviewer가
필요하고 reusable lease가 없을 때만 spawn한다. 동일 revision에 reviewer를 중복 생성하지 않는다.

sub-agent의 reasoning note와 조율 응답에만 `caveman` 압축을 적용한다. review 문서, workflow 산출물, 코드, commit message에는 적용하지 않는다.

메인 에이전트는 입력 범위, requirement graph, evidence manifest와 정본 지침 경로를
전달한다. reviewer는 유효한 evidence를 재사용하고 stale·missing·invalid 또는 독립 실행
requirement만 재실행한다. 메인 에이전트는 sub-agent 결과를 검토 결과로 통합한다.

required/achieved verification level을 기록하고 smoke·component·live E2E를 구분한다. 범위 밖
finding은 stable ID로 반환하고 미결정 disposition이 있으면 `needs_input`으로 종료한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
