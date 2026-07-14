# ChangeSet 문서 범위

각 workflow 실행은 `origin/main` 또는 `HEAD` 기반 sibling worktree 하나와 그 안의 `docs/changes/active/<CHG-ID>/`만 사용한다.

```text
docs/changes/active/<CHG-ID>/
  changeset.md
  requirements.md
  ubiquitous-language.md
  use-cases.md
  use-cases/<UC-ID>/
    use-case.md
    e2e-goal.md
    event-storming.md
```

- `<CHG-ID>` 밖 workflow 문서는 읽거나 수정하지 않는다.
- orchestrator는 새 요청마다 `<CHG-ID>`와 `changeset.md`를 만든다.
- 기존 ChangeSet 재개는 사용자가 `<CHG-ID>`를 지정했을 때만 허용한다.
- 새 ChangeSet worktree는 저장소 부모 디렉터리의 `<repo-name>-<CHG-ID>`이고 branch는 `changes/<CHG-ID>`다.
- ChangeSet 산출물은 PR·`main`에 포함하지 않는다.
