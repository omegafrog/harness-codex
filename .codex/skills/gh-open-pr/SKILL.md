---
name: gh-open-pr
description: Create or update GitHub pull requests with issue links, plan context, and safe closing triggers.
---

# gh-open-pr

## Purpose

Create or update a GitHub pull request after the caller has prepared the complete change or plan set.
Use a draft PR for a plan-set handoff. Use a ready PR only when the caller explicitly requests it
or the implementation workflow has completed its verification gates.

## Preconditions

- Confirm the repository and caller-captured current session base branch from Git, not from memory.
- Confirm the head branch is pushed and the PR source is the intended branch.
- Confirm the caller-supplied fixed base ref is an ancestor of the head branch.
- Pass the caller-captured current session base branch unchanged to `gh pr create --base`. Do not infer or substitute the repository default branch.
- For a plan PR, confirm every split plan has been created and linked to the parent Issue.
- For a plan PR, confirm every child Issue has the configured `Planned` status.
- For an implementation PR with automatic closing, confirm its base is the repository default branch. GitHub ignores closing keywords when the PR targets another branch; if the captured base is not the default branch, stop and report that automatic Issue closing cannot be guaranteed.
- Determine the implementation PR scope before writing closing keywords: `plan-set implementation PR` covers the full parent/child plan set; `child-scoped implementation PR` covers one child only.
- Do not create a PR in `local-markdown` tracker mode.
- If the head branch has no commits beyond the base branch, report that GitHub cannot create the PR yet.

## Core Rules

- Use `gh pr create` for a new PR and `gh pr edit` for an existing PR.
- Never merge or close a PR. The user owns the final merge or close decision.
- Prefer `--draft` for a plan-set PR.
- Use `--body-file` for multi-section bodies; do not place long Markdown in shell quoting.
- When automatic closing is required, state it on one line at the bottom of the PR body.
- Recommended phrases: `Closes #123`, `Fixes #123`, `Resolves #123`
- Use `#123` for issues in the same repository.
- Put one closing trigger on each line when closing multiple issues.
- Never add a closing trigger to a plan PR: planning does not complete implementation Issues.
- For an implementation PR covering a plan set, include the parent Issue and every child Issue, each on its own closing-keyword line at the bottom of the body. Use `Closes #<PARENT-ISSUE-NUMBER>` and one `Closes #<CHILD-ISSUE-NUMBER>` line per child.
- plan set implementation PR에서는 parent Issue와 모든 child Issue를 포함하고, 각 Issue에 closing keyword를 한 줄씩 추가한다.
- A child-scoped implementation PR must include a closing keyword only for its target child; leave the parent and sibling child Issues open until the full plan set is merged.
- Do not add a closing trigger when the issue must remain open.
- Do not rely on the title; include the trigger in the body.
- Never close or change Issue or Project status as a side effect of PR creation.
- Preserve caller-captured session branch lineage. `gh-open-pr` validates the base; it does not independently replace it.

## Plan PR Body

For diagram links in a draft plan PR, include only available, non-empty ticket-scoped SVG artifacts. Use a head-branch-qualified URL in the form `../blob/<head-branch>/docs/specs/<ticket-id>/diagrams/<product-or-architecture>/<diagram>.svg?raw=true`; do not use an unresolved local-relative link. A missing or explicitly `해당 없음` Product/Architecture diagram is valid: record or omit that optional link and continue the plan PR without blocking it.

다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`으로 계획 PR 검증 결과에 기록한다. 이는 계획 PR 생성을 차단하지 않는다.

For a plan-set PR, use this order:

1. State that the PR contains the approved implementation plan set.
2. Link the parent Issue and every child Issue.
3. Summarize dependencies and execution order.
4. Link the Product Spec and Architecture Spec, including class and state diagrams.
5. Record the planning validation performed.
6. State that implementation and completion gates remain pending.
7. State the captured session base branch.

```md
## Plan Set
- Parent: #123
- Child plans: #124, #125

## Execution Order
1. #124 — prerequisite
2. #125 — depends on #124

## Specifications
- Product Spec: `docs/specs/<ticket-id>/product-spec.md`
- Architecture Spec: `docs/specs/<ticket-id>/architecture-spec.md`
- Class diagram: `<link or heading>`
- State diagram: `<link or heading>`

## Planning Validation
- All split plans approved and created.
- Dependencies and tracker statuses verified.

## Remaining Work
- Implementation, verification, and completion remain pending.
- Base branch: `<captured session branch>`
```

Do not add `Closes`, `Fixes`, or `Resolves` to this body.

## Implementation PR Body

1. Confirm the linked Issue number and repository scope.
2. Write a title that makes the implementation intent clear.
3. Add the problem, change flow, and test or verification results.
4. Read and use the repo-local `.codex/skills/eli5/SKILL.md` as the explanation pass. Put its output first under `## 한눈에 보기`: 한 문장, 최대 세 단계의 `Before → After` 흐름.
5. For every changed PlantUML diagram, add an independent `<details>` block. Its `<summary>` must include the requirement or use-case ID·이름·유형 (ID, diagram name, and type).
6. Link each diagram with a head-branch-qualified URL in the form `../blob/<head-branch>/docs/specs/<ticket-id>/diagrams/<product-or-architecture>/<diagram>.svg?raw=true` so GitHub renders the SVG.
7. Replace the former Mermaid preview rule with the PlantUML SVG preview rule; do not add a Mermaid block for this flow.
8. For a plan-set implementation PR, put one closing line at the bottom for the parent Issue and every child Issue. For a child-scoped implementation PR, put one closing line only for the target child. These Issues close only after the implementation PR merges.
9. Confirm that each closing phrase targets the intended Issue and that the PR scope matches the closing list.

## Body Example

~~~md
## 한눈에 보기
로그인한 사용자가 댓글을 남길 수 있게 됩니다.
1. Before: 비로그인 요청 → After: 로그인 요청만 통과
2. Before: 댓글 생성 불가 → After: `loginService` 검증 후 `TokenProvider`가 발급한 토큰으로 생성

## 변경 다이어그램
<details>
<summary>UC-001 · 댓글 제출 · Activity</summary>

![UC-001 댓글 제출 Activity](../blob/<head-branch>/docs/specs/<ticket-id>/diagrams/product/UC-001.activity.svg?raw=true)
</details>

## 검증
- `Postman`으로 로그인 후 댓글 생성을 확인했습니다.
~~~

Closes #123
Closes #124
Closes #125

## Commands

Use the configured repository and current branch:

```bash
gh pr create --draft --base <base-branch> --head <head-branch> \
  --title "<title>" --body-file <body-file>
```

If a PR already exists for the head branch:

```bash
gh pr edit <number> --title "<title>" --body-file <body-file>
```

## User-Owned Finalization

This skill stops after creating or updating the PR. The user decides whether to:

- mark a draft PR ready
- merge the PR
- close the PR without merging

Do not run `gh pr merge`, `gh pr close`, or an equivalent API operation.

## Post-Merge Reconciliation

After the user merges an implementation PR, the next tracker status pass must verify that the PR is merged, the intended parent/child Issues are closed, and their configured Project `Workflow Status` is `Done`. Recalculate dependent tickets only after these checks pass. If Project automation did not set `Done`, update the selected GitHub Project explicitly; do not copy status to local Markdown.

## Notes

- Automatic closing occurs when the PR merges into the repository default branch and auto-close is enabled.
- Use the correct repository qualifier for issues in another repository.
- Do not leave a closing trigger on a plan PR or an Issue that should remain open.
