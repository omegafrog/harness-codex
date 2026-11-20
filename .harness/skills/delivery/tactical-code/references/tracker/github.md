# GitHub tracker

이 파일은 `.harness/harness.yaml`의 `tracker.mode: github`일 때만 읽는다. GitHub Issue와 configured GitHub Project가 ticket 상태·승인·의존성의 기준이다. `.harness/harness.yaml`의 repository, project owner/number, status field를 사용한다.

## 구현 시작 전 확인

`tracker-publish`가 `harness-publication.mjs activate`로 계획을 저장소 Issue로 바꾸고, parent/child sub-issue 관계와 의존성까지 만든 뒤 완료한다. 구현 시작 전에는 `node .harness/scripts/harness-tracker.mjs check --root <workspace_root>`로 Issue를 확인만 한다. Project에 아직 draft가 남아 있으면(이전 Harness로 발행된 계획) 같은 `activate`를 한 번 실행한 뒤 다시 확인한다. 이 변환·연결을 직접 API로 수행하지 않으며, 미변환 draft를 구현 차단 사유로 반환하지 않는다. `check`가 통과한 뒤에만 선택한 child를 `In Progress`로 바꾸고 구현을 dispatch한다.

- split plan별 child Issue와 parent Issue 연결은 `node .harness/scripts/harness-context.mjs`가 돌려주는 `plan_tickets`(plan ID → ticket 참조)와 `docs/plans/<plan-set-id>/plans.md`로 확인한다. 티켓 번호를 plan 순서나 이름에서 짐작하지 않는다. Issue 번호는 plan 순서를 따르지 않으며, `harness-tracker.mjs check|sync`는 이 stage가 구현하는 plan이 아닌 티켓을 거부한다. 아직 draft인 plan은 Issue 부재 오류가 아니며, 구현 시작 전에 변환한다. 조회 실패는 부재로 간주하지 않는다.
- 실행 후보의 lifecycle 상태는 로컬 plan Issue `docs/plans/<plan-set>/<plan-id>.md` frontmatter에서 읽는다. GitHub Issue/Project의 `Workflow Status`는 보조 mirror다. Project membership 또는 mirror의 Planned 상태만으로 planning approval을 대신하지 않는다. 현재 입력에 대한 planning review gate도 통과해야 dispatch한다.
- 선행 plan의 완료 여부는 `node .harness/scripts/harness-tracker.mjs dependencies --root <workspace_root>`의 `status`와 `incomplete`로만 판단한다. 이 명령은 로컬 canonical ticket 상태와 plan의 `의존성` 절에서 계산하므로 Issue 번호나 Project 상태 조회에 의존하지 않는다. Issue 번호는 보조 mirror mapping이며 status의 정본이 아니다. `blocked`이면 `incomplete`의 plan이 끝날 때까지 대기한다. shared-resource 사실은 연결된 parent/child Issue 및 Project에서 읽는다. 필요한 로컬 plan 근거나 로컬 상태가 없거나 모순되면 구체 근거를 보고하고 dispatch를 막는다. GitHub API 조회 실패는 로컬 상태를 대체하거나 계획 완료 판정을 막지 않는다.
- Issue가 plan index에 연결되지 않았으면 현재 reviewed ledger와 검증된 parent/child mapping으로만 index를 보완한다. API/read 실패로 Issue 부재나 승인 여부를 추정하지 않는다.
- 로컬 상태 전이는 `docs/plans/<plan-set>/<plan-id>.md` frontmatter에 먼저 기록한다. GitHub Project `Workflow Status`와 기본 `Status`는 best-effort mirror로 맞추며 API 오류나 불일치가 로컬 판단을 덮어쓰지 않는다. child Issue는 PR merge 전까지 open으로 둔다. PR merge 뒤에는 GitHub 기본 automation이 의도된 closure를 반영하는지 확인한다. 상태 전이는 이 문서의 절차를 따른다.

Canonical 상태 이름은 `planned`, `in-progress`, `blocked`, `completed`이며 로컬 plan Issue frontmatter가 소유한다. GitHub의 `Workflow Status`와 기본 `Status`는 보조 mirror다.
