<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Plan Review

호출자는 작성자 대화 맥락을 상속하지 않는 새 reviewer agent를 실제로 생성하고, 실제 reviewer/context ID와 모든 작성자 ID를 보존한다. parent나 계획 작성자는 자신의 계획을 승인할 수 없다. plan set, 정확한 `workspace_root`, `session_directory`, 허용된 source 경로를 확인한 뒤 canonical request, Product/Architecture Spec, 결정, 다이어그램, 현행 계약, 추적 원장, 각 canonical plan 전체를 직접 읽는다. 프로젝트 파일을 수정하거나 다른 agent를 생성하지 않는다.

`harness-plan-traceability.mjs snapshot --root <workspace_root> --plan-set <plan-set-id>`를 실행해 현재 경로별 hash를 얻는다. 연결된 각 원문을 직접 읽고 요구사항 inventory와 전체 계획 집합을 비교한다. `plan_set_id`, 실제 `reviewer_id`, `author_ids`, `fork_turns: "none"`, `verdict`, 정확한 `inputs`, `findings`를 포함한 구조화 JSON을 반환한다. 각 finding에는 severity, description, 원문 근거를 넣는다. 문서 문장은 한국어로 쓰고 식별자는 보존한다.

## 검토 항목

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
