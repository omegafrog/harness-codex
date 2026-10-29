<!-- 내부 참조 문서 -->

# worktree CLI

실행 파일은 `.codex/scripts/harness-workflow-worktree.mjs`다. 모든 경로 인자는 절대 경로로 전달한다.

| 명령 | 입력 | stdout JSON | 파일 |
|---|---|---|---|
| `create` | `--root <source_workspace>`; 기존 branch 재사용 시 선택적으로 `--branch <branch>`; 기존 Spec/plan을 위한 새 worktree면 `--plan-set-id <id>` | 생성된 `worktree_id`, `workspace`, `source_workspace`, `return_root`, 선택된 `plan_set_id`, `branch`, `head`, `state`, `session_directory` | `<session_directory>/worktree.json` 생성 후 lifecycle 갱신 |
| `register` | `--root <existing_worktree>`; 선택적으로 `--return-root <source_workspace>`, `--plan-set-id <id>` | 등록된 worktree 정보와 `state` | 해당 worktree의 `<session_directory>/worktree.json` 생성 또는 갱신 |
| `bind-plan-set-id` | `--root <active_workspace>`, 새 Spec은 `--feature-name <name>` 또는 기존 세트는 `--plan-set-id <id>` | 갱신된 active worktree record | 새 Spec workflow에서 `spec-me`가 정한 feature name을 readable slug로 한 번 기록. 같은 ID 재호출은 허용하고 다른 ID로 변경은 거부 |
| `finish` | `--root <workspace>`; `--outcome <completed|failed|aborted|handoff>`; worktree 경로 제거 후에는 `--repository <source_workspace>`; 선택적으로 `--worktree-id <UUID>` 교차 확인 | `state`, `return_root`, `recovery_path`, `recovery_ref`, `branch`, `head` | 같은 `<session_directory>/worktree.json`에 종료 상태와 복구 정보 갱신 |
| `list` | `--root <workspace_in_repository>` | 해당 저장소의 미종료 worktree 정보 JSON 배열 | 파일 변경 없음 |

`--root`는 모든 명령에서 필수이며 절대 경로다. `create`의 stdout에 포함된 `session_directory`가 정본 파일의 위치다. workflow와 하위 단계는 이 JSON을 읽어 worktree 정보를 얻고, 종료 CLI는 파일에서 ID와 원본 경로를 읽어 같은 파일을 갱신한다. workflow 요청마다 개별 필드를 복사하지 않는다.

| JSON field | 설명 |
|---|---|
| `worktree_id` | CLI가 발급한 실행 ID. 종료 시 별도 인자로 전달하지 않으면 파일에서 읽는다. |
| `plan_set_id` | `spec-me`가 새 Spec workflow에서 feature name으로부터 생성하거나, 기존 Spec/plan을 위한 새 worktree 생성 시 명시적으로 전달한 계획 집합 ID. 설정 후 변경할 수 없다. |
| `workspace` | 실행 linked worktree의 절대 경로 |
| `source_workspace` / `return_root` | 원본 workspace 경로 |
| `branch` / `head` | 생성 branch와 시작 commit |
| `session_directory` | 이 파일과 세션 출력이 보존되는 절대 경로 |
| `state` / `outcome` | 현재 lifecycle 상태와 종료 이유 |
| `recovery_path` / `recovery_ref` | 정리 archive 위치와 Git recovery ref; 종료 후 추가된다. |
| `common` / `git_dir` / `registered_at` | Git 공통 디렉터리, linked worktree git directory, 등록 시각 |
| `agent_sessions` | orchestrator와 각 stage/subtask의 마지막 Codex session ID와 execution ID. `worktrees.mjs`가 안전하게 기록한다. |

```sh
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace>
node .codex/scripts/harness-workflow-worktree.mjs create --root <source_workspace> --plan-set-id <existing-plan-set-id>
node .codex/scripts/harness-workflow-worktree.mjs bind-plan-set-id --root <workspace> --feature-name "Solo TRPG D6 narration"
node .codex/scripts/harness-workflow-worktree.mjs finish --root <workspace> --outcome aborted
```
