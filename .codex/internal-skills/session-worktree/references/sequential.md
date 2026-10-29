# 순차 구현

기존 구현 위치에서 한 계획씩 실행한다. 이 파일은 `workspace_mode=sequential` 전용이며, wrapper와 하위 구현·검증 단계는 이 파일만 읽는다.

## 실행 위치

- `docs/plans/<plan-set-id>/<plan-id>.md`의 `## 범위`에 있는 `workspace_root`·`workspace_branch`와 `docs/plans/<plan-set-id>/plans.md`의 `## 실행 위치`를 읽고 사용자 지정 위치와 대조한다. 필드 누락·충돌·제거된 경로·detached HEAD는 tracker 전환이나 쓰기 전에 중단한다.
- 해당 절대 경로를 `execution_line`, 구현 agent의 `workspace_root`와 `cwd`로 사용한다. `git rev-parse --show-toplevel`, `git branch --show-current`, `git worktree list --porcelain`이 계획의 경로·브랜치·등록과 일치해야 한다. `expected-root`도 계획의 경로로 고정한다.
- 과거 checkpoint·`worktree.json`·Architecture review의 `session_worktree`는 현재 실행 위치를 결정하지 않는다. 계획 전환·재개·병합 후에도 같은 위치와 브랜치를 유지한다. 실행 대상에 승인 Spec·계획이 없으면 통합을 인계하고 반영 전 dispatch를 차단한다.

## 실행과 종료

- 새 worktree를 만들지 않는다. create/reserve/register를 호출하거나 기존 위치에 workflow 소유권을 붙이지 않는다. `worktree.json` 생성을 요구하지 않는다.
- 모든 agent/tool에 `workspace_mode=sequential`, 이 파일의 절대 `workspace_reference`, 절대 `workspace_root`, `cwd`, `shared_guidance_root`, `session_directory`를 전달한다. 원래 프로젝트의 공용 지침을 읽고 Git common directory가 일치하는지 확인한다.
- 로그·임시 파일·검증 증거는 `harness-session-output.mjs --root <workspace_root>`가 반환한 session 안에 둔다. 다음 명령에 cwd가 자동 상속된다고 가정하지 않는다.
- 구현·검증·커밋을 기존 브랜치에서 수행한다. 별도 구현 branch를 통합하는 단계는 없다. 전체 plan set 완료 후 기존 실행 브랜치로 하나의 PR을 만든다.
- 완료·실패·중단·handoff에서 소유 agent/서버/쓰기를 종료하고 checkpoint·검증 근거를 보존한다. 기존 작업 위치는 archive/finish/삭제 대상으로 삼지 않는다. 공통 완료 gate는 적용하되 worktree 정보 파일의 생성이나 제거를 완료 조건으로 추가하지 않는다.
