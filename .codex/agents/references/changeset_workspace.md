# ChangeSet Workspace

호출자가 준 `<CHG-ID>`로 다음 script만 실행한다.

```sh
python3 .codex/skills/harness-changeset-workspace/scripts/create_worktree.py <CHG-ID>
```

script 반환의 `worktree`와 `branch`, `base`를 반환한다. `origin/main` ref가 없으면 script의 `HEAD` fallback을 허용한다. 실패하면 `blocked`와 최소 원인만 반환한다.

worktree 안에 문서를 만들거나 현재 worktree의 변경을 수정하지 않는다.
