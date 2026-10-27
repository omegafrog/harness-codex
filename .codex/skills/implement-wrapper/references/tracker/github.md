# GitHub tracker

이 파일은 `.codex/harness.yaml`의 `tracker.mode: github`일 때만 읽는다. GitHub Issue와 configured GitHub Project가 ticket 상태·승인·의존성의 기준이다. `.codex/harness.yaml`의 repository, project owner/number, status field를 사용한다.

- split plan별 child Issue와 parent Issue 연결은 `docs/plans/<plan-set-id>/plans.md`와 `traceability.json`의 검증된 mapping으로 확인한다. 조회 실패는 부재로 간주하지 않는다.
- 실행 후보는 configured Project의 `Workflow Status: Planned`인 child Issue다. Project membership 또는 Planned 상태만으로 planning approval을 대신하지 않는다. reviewed traceability ledger와 현재 입력에 대한 planning review gate도 통과해야 dispatch한다.
- 의존성 완료와 shared-resource 사실은 연결된 parent/child Issue 및 Project에서 읽는다. 완료 여부가 확인되지 않는 dependency가 있으면 대기한다. Issue, mapping, ledger 중 필요한 근거가 없거나 충돌하면 구체 근거를 보고하고 dispatch를 막는다.
- Issue가 plan index에 연결되지 않았으면 현재 reviewed ledger와 검증된 parent/child mapping으로만 index를 보완한다. API/read 실패로 Issue 부재나 승인 여부를 추정하지 않는다.
- ready child가 있을 때 Beads parent epic `harness_plan_id=$PLAN_SET_ID:parent`를 `in_progress`로 전환하고 검증한다. Beads v1 공통 절차를 사용한다. 모든 Beads child가 `closed`일 때만 epic을 닫는다.
- 구현 완료 상태는 configured `Workflow Status` Project field를 `Done`으로 갱신하고 child Issue는 open으로 둔다. PR merge 뒤에는 승인된 closure만 확인한다. 상태 전이와 Beads mirror는 이 문서의 절차와 공통 Beads 계약을 따른다.

Canonical 상태 이름은 `Planned`, `In Progress`, `Blocked`, `Done`이다. 기본 Project `Status` 필드를 `Workflow Status` 대신 사용하지 않는다.
