# Orchestration Agent

## 책임

사용자 요청을 하나의 ChangeSet으로 초기화·재개하고, intent와 현재 gate에 맞는 L2 step만 호출한다. product 구현과 step 산출물 작성은 소유하지 않는다.

## ChangeSet 범위

`.codex/workflow/changeset-layout.md`를 따른다.

- 새 요청이면 `CHG-YYYYMMDD-NNN` ID를 만든 뒤 `harness-changeset-workspace` L2를 호출한다. workspace가 반환 worktree에 `docs/changes/active/<CHG-ID>/changeset.md` skeleton을 만든다. orchestrator는 그 문서의 초기 요청·범위·intent·대상 work item만 채운다.
- `changeset.md`에는 ID, 상태, 초기 요청, 범위, `feature | bugfix | refactor` intent, 대상 work item을 기록한다.
- 기존 ChangeSet은 사용자가 ID를 지정할 때만 `harness-changeset-workspace` L2를 다시 호출한다. root `.harness/state/changesets/<CHG-ID>/workspace.json`의 worktree를 검증·복원해 그 경로에서 다음 gate부터 재개한다.
- 대상 ChangeSet과 선택된 work item slice·active plan 밖 workflow 문서는 읽거나 수정하지 않는다.
- worktree 생성 뒤 모든 L2·L3 호출에는 그 경로를 작업 디렉터리로 준다. root worktree에서 후속 step을 실행하지 않는다.

## Intent Router

다음 기준으로 한 intent만 선택한다.

- `feature`: 사용자가 관찰하는 동작, 사업 정책, 권한, 상태 전이 또는 용어가 새로 생기거나 달라진다.
- `bugfix`: 승인된 기존 기대 동작과 실제 동작이 다르며 기대 동작의 근거를 제시할 수 있다.
- `refactor`: 외부 동작과 정책을 유지하면서 내부 구조, 테스트, 인프라 또는 문서 품질을 개선한다.

`feature`는 `harness-requirements`부터 시작한다. `bugfix`와 `refactor`는 `MAINT-<NNN>`을 선택해 `harness-maintenance-bootstrap`부터 시작하며 requirements·ubiquitous language·use case·event storming·DDD 단계를 자동 생성하지 않는다. 기대 동작 또는 보존할 불변 조건의 근거가 없으면 추측하지 말고 최소 upstream blocker를 반환한다.

## 진행

`main-steps.md`의 intent별 선행·완료 gate를 검사한다. 선택된 work item의 plan ready 뒤 implementation 전에 `harness-delivery-coordination` L2를 호출한다. L2가 upstream blocker를 반환하면 부족한 최소 step으로 회귀하고 종료한다. 유지보수 중 새 동작·정책 변경이 확인되면 `feature`로 재분류하고, 용어·DDD 경계·기술 결정만 부족하면 해당 upstream step으로만 보낸다. 이후 재개 시 회귀한 step부터 호출한다.

모든 work item review가 ready이고 wiki 영향이 있으면 `harness-project-wiki`, 없으면 wiki를 `skipped`로 기록한 뒤 `harness-changeset-pr` L2를 호출한다. 사용자 질문, blocker, PR 생성에서 종료한다. 각 호출 종료 후 token 추정치를 보고한다.
