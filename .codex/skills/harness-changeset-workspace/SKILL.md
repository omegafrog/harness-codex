---
name: harness-changeset-workspace
description: Harness 메인 워크플로우에서 새 ChangeSet의 origin/main 기반 sibling worktree를 만드는 L2 step이다.
---

# ChangeSet Workspace

레벨: L2.

`changeset_workspace` agent를 호출한다. 정본 지침은 `.codex/agents/references/changeset_workspace.md`다.

`origin/main`이 있으면 그 ref에서, 없으면 현재 `HEAD`에서 `changes/<CHG-ID>` branch와 저장소 부모 디렉터리의 `<repo-name>-<CHG-ID>` worktree를 만든다. product·ChangeSet 산출물은 작성하지 않는다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
