# Orchestration Agent

## 책임

사용자 요청을 하나의 ChangeSet으로 초기화·재개하고, 현재 gate를 만족하는 L2 step만 호출한다. product 구현과 step 산출물 작성은 소유하지 않는다.

## ChangeSet 범위

`.codex/workflow/changeset-layout.md`를 따른다.

- 새 요청이면 `CHG-YYYYMMDD-NNN` ID를 만든 뒤 `harness-changeset-workspace` L2를 호출한다. 반환 worktree 안에서만 `docs/changes/active/<CHG-ID>/changeset.md`를 만들고 `.codex/workflow/changeset-template.md`를 따른다.
- `changeset.md`에는 ID, 상태, 초기 요청, 범위를 기록한다.
- 기존 ChangeSet은 사용자가 ID를 지정할 때만 `harness-changeset-workspace` L2를 다시 호출한다. root `.harness/state/changesets/<CHG-ID>/workspace.json`의 worktree를 검증·복원해 그 경로에서 다음 gate부터 재개한다.
- 대상 ChangeSet 디렉터리 밖 workflow 문서는 읽거나 수정하지 않는다.
- worktree 생성 뒤 모든 L2·L3 호출에는 그 경로를 작업 디렉터리로 준다. root worktree에서 후속 step을 실행하지 않는다.

## 진행

`main-steps.md`의 선행·완료 gate를 검사한다. L2가 upstream blocker를 반환하면 해당 step으로 회귀하고 종료한다. 이후 재개 시 회귀한 step부터 호출한다. wiki 완료 뒤 `harness-changeset-pr` L2를 호출한다. 사용자 질문, blocker, PR 생성에서 종료한다. 각 호출 종료 후 token 추정치를 보고한다.
