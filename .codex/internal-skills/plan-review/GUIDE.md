<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Plan Review

호출자는 작성자 대화 맥락을 상속하지 않는 새 reviewer agent를 실제로 생성하고, 실제 reviewer/context ID와 모든 작성자 ID를 보존한다. parent나 계획 작성자는 자신의 계획을 승인할 수 없다. plan set, 정확한 `workspace_root`, `session_directory`, 허용된 source 경로를 확인한 뒤 canonical request, Product/Architecture Spec, 결정, 다이어그램, 현행 계약, 추적 원장, 각 canonical plan 전체를 직접 읽는다. 프로젝트 파일을 수정하거나 다른 agent를 생성하지 않는다.

## 실행 절차

1. 호출자는 확정 답변·Spec·다이어그램·canonical plan·추적 원장의 변경을 함께 반영하고 실제 작업 경로·브랜치를 대조한다. `harness-plan-traceability.mjs begin --root <workspace_root> --plan-set <plan-set-id>`를 실행한다. 이 명령의 기존 snapshot 검사가 요구 inventory·정본·대응표를 검사한다. `status: pass`와 `attempt_id`·`inputs`를 보존한 뒤 fresh reviewer를 생성한다.
2. reviewer는 `snapshot`으로 같은 입력을 직접 읽고 요구사항 inventory와 전체 계획 집합을 비교한다. `plan_set_id`, 실제 `reviewer_id`, `author_ids`, `fork_turns: "none"`, `verdict`, 정확한 `inputs`, `findings`를 포함한 구조화 JSON을 반환한다. 각 finding에는 severity, description, 원문 근거를 넣는다. 검토 중 해당 입력을 고정한다.
3. 호출자는 실제 reviewer metadata와 원본 결과를 session JSON에 보존하고 `harness-plan-traceability.mjs record --root <workspace_root> --plan-set <plan-set-id> --attempt <attempt_id> --reviews <session-relative JSON>`을 실행한다. pass 결과를 원장의 `review`에 반영한 뒤 기존 planning/dispatch 검사를 실행한다.
4. 수정 필요 시 지적 전체와 영향 문서를 함께 고치고 다음 `begin`을 실행한다. 최초 검토와 재검토 2회를 적용하고 이전 지적의 해결·재발·새 결함을 구분한다. 취소·stale도 횟수에 포함한다. 종료·취소된 reviewer는 agent 종료 뒤 `abort ... --attempt <attempt_id> --reason '<사유>'`로 기록한다. 중복 실행·미변경 재요청·한도 초과는 CLI가 차단하며 한도 도달 시 남은 쟁점과 필요한 결정을 사용자에게 제시한다. pass 이후 다른 변경은 새 묶음으로 검토한다.

## 검토 항목

한도 도달 후 사용자가 범위·결정을 명시적으로 바꾸면 원문을 요청 기록에 보존하고 `resolve --root <workspace_root> --plan-set <plan-set-id> --reason '<사용자 결정 원문과 위치>'`로 재개 근거를 기록한다. 변경된 입력으로 다음 `begin`을 실행한다. 사용자의 실제 결정·권한 확인은 호출자가 담당한다.

- 각 canonical plan의 범위 첫 두 항목과 index의 실행 위치에 절대 `workspace_root`와 실제 `workspace_branch`가 있고 값이 일치하는지 확인한다. 기존 구현 대상의 Git root·등록·브랜치와 대조하고, 종료 시 삭제될 계획용 임시 경로 또는 Architecture review session 경로를 대신 썼으면 major finding이다.

- Every declared source requirement is inventoried once and maps to a plan or a justified explicit exclusion.
- Every applicable System Target and accepted Architecture Decision is inventoried and maps to its implementing plan or a justified explicit exclusion.
- For each covered requirement, verify that every owning plan has explicitly mapped acceptance criteria and executable verification cases; requirement IDs alone are insufficient.
- For each covered performance target, verify that the plan's acceptance criteria and verification case preserve its metric, unit, representative workload, measurement environment, baseline/comparison method, and acceptable regression.
- For each accepted Architecture Decision, verify that the implementing plan follows the selected option and its constraints, preserves the cited standards/source references, and has a verification case for the decision's required behavior or quality attribute.
- For each cross-plan handoff, verify the producer's output responsibility, the consumer's input responsibility, the dependency ordering, and a consumer-side verification scenario.
- Every plan has testable acceptance criteria, prohibited behavior/counterexamples, and executable verification cases.
- Ask whether an implementation could pass every plan acceptance criterion while violating the original rule. If so, report a major finding.
- Multi-plan requirements have an integration owner and concrete end-to-end scenario.
- Ordering, ownership, retries, errors, resumption, and state/data preservation are unambiguous.

hash 통과는 입력의 현재성과 참조만 확인한다. 의미상 완전성, 실제 reviewer 격리, receipt 발행자 신원은 증명하지 않는다. blocker/major finding이 남으면 승인할 수 없다. 수정 후에는 다른 fresh reviewer가 새 snapshot을 검토해야 한다.
