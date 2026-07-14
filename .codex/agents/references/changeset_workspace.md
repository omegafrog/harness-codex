# ChangeSet Workspace

호출자가 준 `<CHG-ID>`로 다음 script만 실행한다.

```sh
python3 .codex/skills/harness-changeset-workspace/scripts/create_worktree.py <CHG-ID>
```

script 반환의 `worktree`와 `branch`, `base`, `copied`, `state_file`, `token_estimation_basis`, `changeset_document`를 반환한다. `origin/main` ref가 없으면 script의 `HEAD` fallback을 허용한다. script는 현재 worktree의 ignore된 `.codex`, `harness`, `harness_codex`, `completions`를 새 worktree에 복사하고 `.codex/workflow/token-estimation.md` 존재를 검증한다. 이어 template으로 `docs/changes/active/<CHG-ID>/changeset.md` skeleton을 만든다. root `.harness/state/changesets/<CHG-ID>/workspace.json`에 `active` 상태를 저장한다. 같은 ID면 state와 skeleton을 검증해 worktree를 재개한다. 실패하면 `blocked`와 최소 원인만 반환한다.

worktree 안에 문서를 만들거나 현재 worktree의 변경을 수정하지 않는다.
