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

`create`를 제외한 명령은 `--root`가 필수다. `create`의 stdout에 포함된 `session_directory`가 정본 파일의 위치다. workflow와 하위 단계는 이 JSON을 읽어 worktree 정보를 얻고, 종료 CLI는 파일에서 ID와 원본 경로를 읽어 같은 파일을 갱신한다. workflow 요청마다 개별 필드를 복사하지 않는다.

| JSON field | 설명 |
|---|---|
| `worktree_id` | CLI가 발급한 실행 ID. 종료 시 별도 인자로 전달하지 않으면 파일에서 읽는다. |
| `plan_set_id` | compose 준비 시 초기 요청의 feature name으로 생성하거나 기존 Spec/plan에서 확인한 계획 집합 ID. 설정 후 변경할 수 없다. |
| `workspace` | 실행 linked worktree의 절대 경로 |
| `source_workspace` / `return_root` | 원본 workspace 경로 |
| `branch` / `head` | 생성 branch와 시작 commit |
| `session_directory` | worktree 아래 `.io`의 절대 경로 |
| `state` / `outcome` | 현재 lifecycle 상태와 종료 이유 |
| `common` / `git_dir` / `registered_at` | Git 공통 디렉터리, linked worktree git directory, 등록 시각 |
| `agent_sessions` | orchestrator와 각 stage/subtask의 마지막 Codex session ID와 execution ID. `worktrees.mjs`가 안전하게 기록한다. |

```sh
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace>
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace> --plan-set-id <existing-plan-set-id>
node .codex/scripts/harness-workflow-worktree.mjs bind-plan-set-id --root <workspace> --feature-name "Solo TRPG D6 narration"
node .codex/scripts/harness-workflow-worktree.mjs finish --root <workspace> --outcome aborted
```
