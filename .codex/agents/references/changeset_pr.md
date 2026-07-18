# ChangeSet PR

worktree에서만 실행한다.

1. 현재 branch가 `changes/<CHG-ID>`인지, `review.md`가 `status: ready`인지 확인한다.
   required/achieved verification level이 있고 deferred finding이 모두 resolved됐는지 확인한다.
2. `./harness run wiki build`를 성공시킨다.
3. `git diff --name-only origin/main...HEAD`에 `docs/changes/active/**`, `docs/use-cases/**`, `docs/maintenance/**`, `docs/plans/active/**`, `.harness/runs/**`가 있으면 `blocked`다.
4. `git push -u origin changes/<CHG-ID>`를 실행한다.
5. `gh pr create --base main`으로 한국어 제목·본문의 PR을 만든다. 본문에는 구현 의도, 구현 방식,
   required/achieved verification level, smoke·component·live E2E 결과, deferred finding disposition과
   Issue URL, 위험·되돌리기를 짧게 기록한다.

PR URL을 반환한다. PR 생성 뒤 worktree는 삭제하지 않는다.
