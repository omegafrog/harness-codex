<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Session worktree

구현 실행 방식을 확인할 때 아래 해당 파일 하나만 읽는다. 작업 단위의 worktree 생성은 `worktree-create` skill을 사용한다. 디렉터리 전체나 모든 reference를 한 번에 읽지 않는다.

소유 session worktree의 정보는 해당 `session_directory/worktree.json`이 정본이다. worktree 생성 CLI가 파일을 만들고 lifecycle 상태를 갱신한다. workflow는 진입 시 파일을 읽고, 하위 stage·agent에는 필요한 경우 `session_directory` 경로만 전달해 같은 파일을 읽게 한다. worktree 메타데이터를 매 요청마다 복사해 입력하지 않는다.

| 호출 맥락 | 읽을 파일 |
|---|---|
| `implement-wrapper`·`implement`의 `workspace_mode=sequential` | [순차 구현](references/sequential.md) |
| `implement-wrapper`·`implement`의 `workspace_mode=parallel` | [병렬 구현](references/parallel.md) |

구현 중 호출하는 review·`sync-contracts`·E2E·PR은 상위에서 받은 `workspace_mode`와 `workspace_reference`를 그대로 따른다. reviewer를 동시에 실행한다는 이유로 구현 방식을 바꾸지 않는다. 구현 하위 단계에 방식이 전달되지 않았다면 먼저 caller에게서 확인하고, 소유 receipt나 과거 session 경로로 추론하지 않는다. standalone `implement`는 병렬 격리 배정이 없으면 `sequential`을 선택한다.

선택한 reference의 준비·재개·종료 규칙을 적용하고 이 문서에서 다른 분기로 넘어가지 않는다. 내부 단계는 상위 workflow의 worktree 소유권을 가져오거나 제거하지 않는다.
