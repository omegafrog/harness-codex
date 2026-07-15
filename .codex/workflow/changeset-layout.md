# ChangeSet 문서 범위

각 workflow 실행은 `origin/main` 또는 `HEAD` 기반 sibling worktree 하나와 선택된 ChangeSet·active plan만 사용한다.

```text
docs/changes/active/<CHG-ID>/
  changeset.md
  requirements.md                  # feature only
  ubiquitous-language.md           # feature only
  use-cases.md                      # feature only
  use-cases/<UC-ID>/...             # feature only
  ddd-architecture.md               # feature only, integrated
  technical-decisions.md            # feature only, ChangeSet-level
  delivery.md
  review.md

docs/maintenance/<MAINT-ID>/        # bugfix/refactor only
  index.md
  change-intent.md
  scope.md
  maintenance-spec.md
  architecture-impact.md
  technical-decisions.md            # optional
  verification-goal.md
  links.md

docs/plans/active/<CHG-ID>/
  plan.md
  verification.md
```

- 선택된 `<CHG-ID>`와 active plan 밖 workflow 문서는 읽거나 수정하지 않는다.
- orchestrator는 새 요청마다 `<CHG-ID>`와 `changeset.md`를 만든다.
- 기존 ChangeSet 재개는 사용자가 `<CHG-ID>`를 지정했을 때만 허용한다.
- 새 ChangeSet worktree는 저장소 부모 디렉터리의 `<repo-name>-<CHG-ID>`이고 branch는 `changes/<CHG-ID>`다.
- worktree 생성 직후 현재 worktree의 로컬 harness 설치물 `.codex`, `harness`, `harness_codex`, `completions`를 복사한다.
- root `.harness/state/changesets/<CHG-ID>/workspace.json`은 branch·worktree·`status: active`·token 추정 기준 경로를 보관한다. 동일 ID 재개는 이 상태를 검증해 해당 worktree에서 시작한다.
- worktree 생성 step은 `.codex/workflow/changeset-template.md`로 `docs/changes/active/<CHG-ID>/changeset.md` skeleton을 만든다. orchestrator는 초기 요청·범위·intent·대상 ChangeSet을 채운다.
- ChangeSet 산출물은 PR·`main`에 포함하지 않는다.
- maintenance slice와 active plan은 선택된 ChangeSet branch에만 유지하고 PR·`main`에 포함하지 않는다.
- `delivery.md`는 외부 저장소 전달 Issue와 준비 상태만 기록한다. 대상 저장소 제품 코드는 이 worktree에서 작성하지 않는다.
