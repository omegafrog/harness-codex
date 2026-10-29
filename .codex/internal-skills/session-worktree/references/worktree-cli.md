<!-- 내부 참조 문서 -->

# worktree CLI

실행 파일은 `.codex/scripts/harness-workflow-worktree.mjs`다. 모든 경로 인자는 절대 경로로 전달한다.

| 명령 | 입력 | stdout JSON | 파일 |
|---|---|---|---|
| `create` | 선택적으로 `--root <source_workspace>` (생략 시 현재 Git root), `--branch <branch>`, `--plan-set-id <id>` | 생성된 `worktree_id`, `workspace`, `source_workspace`, `return_root`, 선택된 `plan_set_id`, `branch`, `head`, `state`, `session_directory` | `<session_directory>/worktree.json` 생성 후 lifecycle 갱신 |
| `register` | `--root <existing_worktree>`; 선택적으로 `--return-root <source_workspace>`, `--plan-set-id <id>` | 등록된 worktree 정보와 `state` | 해당 worktree의 `<session_directory>/worktree.json` 생성 또는 갱신 |
| `bind-plan-set-id` | `--root <active_workspace>`, `--feature-name <name>` 또는 `--plan-set-id <id>` | 갱신된 active worktree record | ID가 없는 기존 worktree에 한 번 기록. 같은 ID 재호출은 허용하고 다른 ID로 변경은 거부 |
| `finish` | `--root <workspace>`; `--outcome <completed|failed|aborted|handoff>`; 선택적으로 `--worktree-id <UUID>` 교차 확인 | `state`, `return_root`, `outcome` | worktree와 `.io` 제거 |
| `list` | `--root <workspace_in_repository>` | 해당 저장소의 미종료 worktree 정보 JSON 배열 | 파일 변경 없음 |

`create`를 제외한 명령은 `--root`가 필수다. `create`의 stdout에 포함된 `session_directory`가 정본 파일의 위치다. workflow와 하위 단계는 이 JSON을 읽어 worktree 정보를 얻고, 종료 CLI는 파일에서 ID와 원본 경로를 읽는다. `finish`는 소유권과 브랜치를 확인하고 백업이나 recovery archive를 만들지 않고 worktree와 `.io`를 제거한다. workflow 요청마다 개별 필드를 복사하지 않는다.

`worktree.json`은 worktree 소유·위치와 현재 단계 ID를 기록한다. 전체 단계 정의와 실행 상태는 `runtime/orchestrator/workflow.json`의 `stages`와 `state`에 있다. 아래의 필수 여부는 현재 `parseWorktreeRecord` 검증 기준이다. 검증기가 추가 필드를 거부하지는 않으므로, 표에 없는 값은 계약된 필드로 간주하지 않는다.

| JSON field | 필수 | 값과 의미 |
|---|---|---|
| `schema_version` | 예 | 정수 `1` |
| `worktree_id` | 예 | UUID. 예약 또는 등록 시 생성하며 종료 시 소유권 교차 확인에 사용한다. |
| `workspace` | 예 | 소유 linked worktree의 절대 경로 |
| `common` | 예 | 해당 저장소 Git common directory의 절대 경로 |
| `return_root` | 예 | 정리 후에도 남는 원본 workspace의 절대 경로 |
| `session_directory` | 예 | worktree 아래 `.io`의 절대 경로 |
| `branch` | 예 | 비어 있지 않은 Git 브랜치 이름. 정리 시 실제 브랜치와 대조한다. |
| `state` | 예 | `allocating`, `active`, `archived`, `removed`, `cleanup-failed`. 현재 생성·등록 경로는 `allocating`과 `active`를 기록하며, 나머지는 기존 기록도 읽을 수 있도록 허용한다. |
| `current_stage` | 아니요 | `WORKTREE_STAGE` enum에 정의된 skill 값이다. 새 worktree는 `workflow-compose`로 시작하고 구성 완료 후 첫 workflow 단계의 skill을 기록한다. 하위 작업 중에는 부모 단계의 skill을 기록한다. enum에 없는 값은 거부한다. 기존 기록에는 없을 수 있다. |
| `source_workspace` | 아니요 | 원본 workspace 경로. 없거나 빈 값이면 읽을 때 `return_root`를 사용한다. |
| `plan_set_id` | 아니요 | 영문자 또는 숫자로 시작하고 이후 영문자·숫자·`.`·`_`·`-`를 쓰는 계획 집합 ID. 한 번 설정하면 다른 ID로 바꿀 수 없다. |
| `git_dir` | 아니요 | 등록 시 기록하는 linked worktree Git directory 경로. 종료 시 존재하면 실제 경로와 대조한다. |
| `head` | 아니요 | 등록 시 Git에서 읽은 HEAD commit ID |
| `registered_at` | 아니요 | 직접 등록 시 기록하는 ISO 8601 시각 |
| `outcome` | 아니요 | 종료 결과의 의미로 `completed`, `aborted`, `failed`, `handoff`를 사용한다. 현재 `finish`는 결과로 반환하며 worktree 삭제 후 파일은 남지 않는다. |
| `agent_sessions` | 아니요 | 객체. 키는 영문자·숫자로 시작하고 이후 영문자·숫자·`_`·`.`·`:`·`-`를 허용한다. 각 값의 `session_id`는 UUID, `execution_id`는 영문자·숫자로 시작하고 이후 영문자·숫자·`_`·`-`를 사용하는 문자열이다. 기록 시 `updated_at` ISO 8601 시각을 추가한다. |

파서는 선택 필드의 경로·시각·commit 형식과 `outcome`을 별도로 검증하지 않는다. 위 경로와 의미는 생성·사용 코드의 동작이며, 파일 존재·Git 등록·브랜치 일치 확인은 별도 lifecycle 검사에서 수행한다.

단계 enum 정본은 `src/workflow/worktree-stages.mjs`의 `WORKTREE_STAGE`다. 각 값은 스킬 ID이며, 설치된 프로젝트에서는 `.codex/harness-runtime/src/workflow/worktree-stages.mjs`에 있다. `worktree.json`에는 단계의 skill을, `workflow.json`의 `state.current_stage`에는 해당 workflow의 단계 ID를 기록한다. 같은 skill을 여러 단계가 사용하면 workflow의 단계 ID로 구별한다.

```sh
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace>
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace> --plan-set-id <existing-plan-set-id>
node .codex/scripts/harness-workflow-worktree.mjs bind-plan-set-id --root <workspace> --feature-name "Solo TRPG D6 narration"
node .codex/scripts/harness-workflow-worktree.mjs finish --root <workspace> --outcome aborted
```

신규 worktree는 `main`에서 생성한다. 생성 전 소유 예약과 잠금은 Git common directory의 `harness-reservations/`에서 lifecycle CLI가 관리한다. 메인 workspace의 `.io`를 예약 저장소로 쓰지 않는다. 요청·입력·workflow·실행 기록은 생성된 worktree의 `.io`에만 둔다.
