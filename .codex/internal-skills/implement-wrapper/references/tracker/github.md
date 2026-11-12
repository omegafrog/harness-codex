# GitHub tracker

이 파일은 `.codex/harness.yaml`의 `tracker.mode: github`일 때만 읽는다. GitHub Issue와 configured GitHub Project가 ticket 상태·승인·의존성의 기준이다. `.codex/harness.yaml`의 repository, project owner/number, status field를 사용한다.

## 구현 시작 전 확인

`tracker-publish`가 `harness-publication.mjs activate`로 계획을 저장소 Issue로 바꾸고, parent/child sub-issue 관계와 Beads mirror·의존성까지 만든 뒤 완료한다. 구현 시작 전에는 `node .codex/scripts/harness-tracker.mjs check --root <workspace_root>`로 Issue와 mirror를 확인만 한다. Project에 아직 draft가 남아 있으면(이전 Harness로 발행된 계획) 같은 `activate`를 한 번 실행한 뒤 다시 확인한다. 이 변환·연결·mirror 생성을 직접 API로 수행하지 않으며, 미변환 draft를 구현 차단 사유로 반환하지 않는다. `check`가 통과한 뒤에만 선택한 child를 `In Progress`로 바꾸고 구현을 dispatch한다.

- split plan별 child Issue와 parent Issue 연결은 `node .codex/scripts/harness-context.mjs`가 돌려주는 `plan_tickets`(plan ID → ticket 참조)와 `docs/plans/<plan-set-id>/plans.md`로 확인한다. 티켓 번호를 plan 순서나 이름에서 짐작하지 않는다. Issue 번호는 plan 순서를 따르지 않으며, `harness-tracker.mjs check|sync`는 이 stage가 구현하는 plan이 아닌 티켓을 거부한다. 아직 draft인 plan은 Issue 부재 오류가 아니며, 구현 시작 전에 변환한다. 조회 실패는 부재로 간주하지 않는다.
- 실행 후보는 configured Project의 `Workflow Status: Planned`인 child Issue다. Project membership 또는 Planned 상태만으로 planning approval을 대신하지 않는다. 현재 입력에 대한 planning review gate도 통과해야 dispatch한다.
- 선행 plan의 완료 여부는 `node .codex/scripts/harness-tracker.mjs dependencies --root <workspace_root>`의 `status`와 `incomplete`로만 판단한다. 이 명령이 plan의 `의존성` 절과 Beads 상태에서 계산하므로 Issue 번호를 plan에 직접 대응시키거나 현재 plan 자신의 티켓을 선행으로 읽지 않는다. `blocked`이면 `incomplete`의 plan이 끝날 때까지 대기한다. shared-resource 사실은 연결된 parent/child Issue 및 Project에서 읽는다. Issue, mapping, ledger 중 필요한 근거가 없거나 충돌하면 구체 근거를 보고하고 dispatch를 막는다.
- Issue가 plan index에 연결되지 않았으면 현재 reviewed ledger와 검증된 parent/child mapping으로만 index를 보완한다. API/read 실패로 Issue 부재나 승인 여부를 추정하지 않는다.
- ready child가 있을 때 Beads parent epic `harness_plan_id=$PLAN_SET_ID:parent`를 `in_progress`로 전환하고 검증한다. Beads v1 공통 절차를 사용한다. 모든 Beads child가 `closed`이고 통합 리뷰·사용자 승인된 최종 E2E·feature 완료 gate가 통과한 뒤에만 epic을 닫는다. child 구현 완료만으로 최종 E2E 전에 parent를 완료 처리하지 않는다.
- 구현 완료 상태는 configured `Workflow Status` Project field를 canonical로 `Done`에 갱신하고 GitHub 기본 `Status`도 `Done`으로 동기화한다. 구현 시작 시 기본 `Status`는 `In Progress`, 계획 대기 시 `Todo`로 맞춘다. `Blocked`는 canonical field에 보존하고 기본 `Status`는 `In Progress`로 둔다. child Issue는 PR merge 전까지 open으로 둔다. PR merge 뒤에는 승인된 closure만 확인한다. 상태 전이와 Beads mirror는 이 문서의 절차와 공통 Beads 계약을 따른다.

Canonical 상태 이름은 `Planned`, `In Progress`, `Blocked`, `Done`이며 설정된 `Workflow Status` field가 소유한다. GitHub 기본 `Status`는 같은 실행 시점이 보이도록 함께 갱신한다.
