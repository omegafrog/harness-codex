---
name: harness-changeset-pr
description: Harness 메인 워크플로우에서 wiki 완료 ChangeSet branch를 push하고 PR을 만드는 L2 step이다.
---

# ChangeSet PR

레벨: L2.

`changeset_pr` agent를 호출한다. 정본 지침은 `.codex/agents/references/changeset_pr.md`다.

`review.md: ready`, unresolved Deferred Finding 0건, wiki strict build 통과 뒤에만
`changes/<CHG-ID>` branch를 push하고 base `main` PR을 만든다. PR 본문에는 required/achieved
verification level과 resolved finding disposition/link를 표시한다. ChangeSet 산출물이 diff에 있으면
`blocked`다. 생성 뒤 worktree는 유지한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
