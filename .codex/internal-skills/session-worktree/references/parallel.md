# 병렬 구현

의존성과 공유 자원 검사를 통과해 동시에 실행할 계획만 격리한다. 이 파일은 `workspace_mode=parallel` 전용이며, wrapper와 해당 worker는 이 파일만 읽는다.

## 통합 대상과 worker 배정

- `docs/plans/<plan-set-id>/<plan-id>.md`의 `## 범위`에 있는 `workspace_root`·`workspace_branch`와 `docs/plans/<plan-set-id>/plans.md`의 `## 실행 위치`가 기존 통합 대상 `execution_line`이다. 사용자 지정 위치, Git root·등록·실제 브랜치와 대조한다. 누락·충돌·제거된 경로·detached HEAD는 tracker 전환이나 생성 전에 중단한다.
- `WorktreeManager.allocate`에 승인된 parallel group, `fixed_group_base`, parent workflow의 `plan_set_id`를 전달한다. 계획마다 전용 `harness/<run>/<group>/<plan>-<instance>` branch와 격리 worktree를 생성한다. 생성 전 reserve, 생성 후 register는 manager가 소유권 기록을 관리하고 동일한 `plan_set_id`를 worker `worktree.json`에 보존한다. 사용자 작업 위치를 workflow 소유로 등록하지 않는다.
- manager가 반환한 worker 경로를 `workspace_root`와 `cwd`로 사용한다. worker의 branch와 ID는 manager가 저장한 `<session_directory>/worktree.json`에서 읽는다. group·고정 base·Git root·등록 검사를 통과해야 spawn한다. canonical plan의 통합 대상은 worker 경로로 덮어쓰지 않는다.
- 모든 agent/tool에 `workspace_mode=parallel`, 이 파일의 절대 `workspace_reference`, worker의 절대 루트, 원래 프로젝트의 `shared_guidance_root`, `session_directory`를 전달한다. worker는 필요할 때 `worktree.json`을 읽는다. 두 루트의 Git common directory가 같아야 한다. 구현자는 worker branch에 커밋하고 검증한 경로·브랜치를 보고한다.
- 필요한 설치·preflight가 실패해도 생성된 worktree의 소유권 기록을 보존하고 정리한다. 로그·임시 파일·checkpoint·복구 자료는 session 안에만 둔다. 최종 branch·구현 commit·고정 base·통합 순서는 checkpoint에 보존한다.

## 통합과 종료

- worker가 쓰는 동안 branch를 통합하지 않는다. 충돌이 확인된 계획은 우선순위가 결정될 때까지 멈춘다.
- 완료된 branch는 `WorktreeManager.integrate`로 계획에 기록한 기존 `execution_line`과 예상 브랜치에 하나씩 통합한다. 대상 clean 상태·공유 고정 base를 검사하고, merge 충돌은 중단해 branch를 보존한다. 통합 gate와 영향 검증을 통과한 뒤 plan set의 PR을 한 번만 만든다.
- 완료·실패·사용자 중단·handoff에서는 해당 worker의 agent/서버/쓰기를 먼저 종료한다. `WorktreeManager.cleanup`으로 소유 worktree만 archive·검증·제거한다. tracked/untracked/ignored 파일과 staged index를 session의 recovery에 보존하고 tree/HEAD/index 검증 전에는 삭제하지 않는다.
- `<session_directory>/worktree.json`은 임시 worker의 소유권·복구·정리와 전달받은 `plan_set_id`를 기록하는 정본이다. `plan_set_id`는 parent가 선택하며 worker worktree에서 재생성하지 않는다. 통합 대상의 실행 위치를 선택하는 근거는 아니다. branch·HEAD·복구 ref·return_root를 보존하고 Git 등록 해제를 확인한다. backup 실패·활성 writer·Git lock을 force로 우회하지 않으며 cleanup 실패는 완료 실패다.
- 질문 대기는 `waiting`으로 기록하고 worker를 유지한다. 실제 종료 outcome은 completed·failed·aborted·handoff를 구분한다. 중단된 생성·정리는 다음 진입에서 `worktree.json`을 읽고 manager의 복구 절차를 따른다. 다른 실행의 활성 worker나 기존 통합 대상은 삭제하지 않는다.
