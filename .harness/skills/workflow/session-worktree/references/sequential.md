# 순차 구현

기존 구현 위치에서 한 계획씩 실행한다. 이 파일은 `workspace_mode=sequential` 전용이며, wrapper와 하위 구현·검증 단계는 이 파일만 읽는다.

## 실행 위치

- 정적 실행기가 정본 `worktree.json`과 실제 Git root·common directory·등록·branch를 검증하고 입력의 `context.execution_workspace`를 생성한다. plan-review의 `details.execution_workspace`도 같은 값이다. 구현은 이 workspace에서 한 계획씩 수행한다.
- 계획·index의 `workspace_root`·`workspace_branch`, 과거 checkpoint, `return_root`를 읽어 구현 위치를 선택하지 않는다. agent가 경로·브랜치를 직접 정하거나 복사하지 않는다.
- 실행기에서 받은 workspace와 실제 cwd가 다르면 쓰기 전에 중단한다. 같은 workflow의 Spec·계획과 source는 정본 worktree에 유지하며 primary main에 따로 옮겨 구현하지 않는다.

## 실행과 종료

- 새 worktree를 만들지 않는다. create/reserve/register를 호출하거나 기존 위치에 workflow 소유권을 붙이지 않는다. `worktree.json` 생성을 요구하지 않는다.
- 하위 호출에는 정본 `worktree_ref`를 사용한다. 도구가 요구하는 cwd·session·실행 위치는 정적 실행기가 해석한다. 프로젝트 지침은 활성 workspace의 추적 파일을 사용한다.
- 로그·임시 파일·검증 증거는 `harness-session-output.mjs --root <workspace_root>`가 반환한 session 안에 둔다. 다음 명령에 cwd가 자동 상속된다고 가정하지 않는다.
- 구현·검증·커밋을 기존 브랜치에서 수행한다. 별도 구현 branch를 통합하는 단계는 없다. 전체 plan set 완료 후 기존 실행 브랜치로 하나의 PR을 만든다.
- 완료·실패·중단·handoff에서 소유 agent/서버/쓰기를 종료하고 checkpoint·검증 근거를 보존한다. 기존 작업 위치는 archive/finish/삭제 대상으로 삼지 않는다. 공통 완료 gate는 적용하되 worktree 정보 파일의 생성이나 제거를 완료 조건으로 추가하지 않는다.
