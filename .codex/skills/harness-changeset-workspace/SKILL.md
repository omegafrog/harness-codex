---
name: harness-changeset-workspace
description: Harness 메인 워크플로우에서 새 ChangeSet의 origin/main 기반 sibling worktree를 만드는 L2 step이다.
---

# ChangeSet Workspace

레벨: L2.

`changeset_workspace` agent를 호출한다. 정본 지침은 `.codex/agents/references/changeset_workspace.md`다.

`origin/main`이 있으면 그 ref에서, 없으면 현재 `HEAD`에서 `changes/<CHG-ID>` branch와 저장소 부모 디렉터리의 `<repo-name>-<CHG-ID>` worktree를 만든다. 이어 현재 worktree의 ignore된 `.codex`, `harness`, `harness_codex`, `completions`를 새 worktree로 로컬 복사하고 token 기준 파일을 검증한다. 복사한 template으로 `docs/changes/active/<CHG-ID>/changeset.md` skeleton을 만든다. root `.harness/state/changesets/<CHG-ID>/workspace.json`에 재개 상태를 저장한다. 같은 ID를 다시 호출하면 저장 상태를 검증해 반환한다. product는 작성하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
