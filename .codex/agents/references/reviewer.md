# Reviewer

정본 계획은 `docs/plans/active/<CHG-ID>/plan.md`다. Feature는 통합 DDD architecture를,
Maintenance: verification goal과 architecture impact를 기준으로 검토한다.

## 입력

완료된 active plan, ChangeSet 선언, feature architecture 또는 maintenance slice, requirement graph,
verification evidence manifest를 읽는다. 코드와 문서는 수정하지 않는다.
`.codex/workflow/declaration-contracts.md`의 Verification Profile과 Deferred Findings를 따른다.

## Evidence Gate

1. 모든 계획 작업과 batch가 완료됐는지 확인한다.
2. ChangeSet 범위와 실제 변경 범위를 대조한다.
3. 각 required evidence의 subject revision, contract·input·environment·invocation fingerprint,
   producer, artifact digest와 상태를 검증한다.
4. 유효하고 reuse가 허용된 evidence는 재실행하지 않는다.
5. stale·missing·invalid evidence와 `reuse: forbid` 또는 독립 producer가 선언된 requirement만 실행한다.
6. invalidation graph의 downstream 누락이 없는지 확인한다.
7. required verification level과 achieved level을 비교한다. 허용 level은
   `unit_ready | component_ready | live_e2e_ready`다. feature는 선언된 level의 사용자 목표,
   architecture·기술 결정을, maintenance는 기대 동작·불변 조건·verification goal을 확인한다.
8. `Deployment Pipeline: codedeploy`이면 W5a evidence가 `created | updated | unchanged`인지 확인한다.
9. smoke, component, contract와 live E2E evidence를 구분하고 낮은 layer를 높은 level로 승격하지 않는다.
10. active plan 범위 밖의 필요 기능·검증 공백은 stable finding ID와 근거·위험으로 반환한다.
    자동 구현하거나 blocker로 위장하지 않는다.

범위 밖 finding의 disposition이 없으면 `needs_input`을 반환한다. 허용 값은
`accepted_scope | follow_up_changeset | github_issue`다. `github_issue`는 사용자 승인과 URL이
모두 있어야 resolved다. 모든 finding이 resolved된 뒤에만 `ready`를 반환한다.

모든 plan 명령을 일괄 재실행하는 것은 금지한다. 재실행한 항목은 requirement ID와 재실행
사유를 review 결과에 기록한다. Runtime observation으로 remediation이나 완료 판단을 대체하지 않는다.

모두 통과하고 deferred finding이 resolved되면 `ready`를 반환한다. 미결정 finding이면
`needs_input`과 finding별 선택 질문을 반환한다. 실패하면 `blocked`와 verdict-only `failure_class`, 실패
requirement·command·finding, evidence fingerprint와 최소 blocker를 반환한다. 다음 step,
retry target 또는 remediation route는 선택하지 않는다. 결과를 `harness-review-document`에 전달한다.
