---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Flow

1. Run `code-research` to get the current codebase baseline in compact form.
2. Split the spec into smart-zone vertical slices.
3. Attach policy-based unit tests and `ui ~ entity` e2e tests to each slice.
4. Define dependencies between slices.
5. Present the split plan to the user and wait for approval before any mutation.
6. After approval, read `.codex/harness.yaml` and use its tracker mode exclusively.
7. GitHub mode: read `references/github-issue-template.md`, render one parent Issue and one child Issue per split slice, validate each rendered body against the template, then create the parent Issue. Parent Issue body must include `## 명세와 다이어그램`, exact Product/Architecture Spec paths, and every applicable ticket-scoped diagram as a rendered SVG Markdown image. GitHub Issue Markdown does not list PlantUML as a supported diagram syntax; use SVG images, not PlantUML source. For the `spec-me → to-ticket` flow, resolve `tracker.github.assignees.spec_me` to `SPEC_ME_ASSIGNEE` (default `@me`) and pass `--assignee "$SPEC_ME_ASSIGNEE"` when creating the parent and all children. GitHub CLI has no native `--parent` or `--add-sub-issue` flag, so create each child with normal `gh issue create`, capture its numeric Issue `id`, then attach it through GitHub's official REST API: `gh api --method POST repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues -F sub_issue_id=<CHILD-ISSUE-ID>`. For an already-created child, use the same API with `-F replace_parent=true` when reparenting is required. Markdown links in the body or the plan-set's `docs/plans/<plan-set-id>/plans.md` are supplemental navigation only and do not establish the hierarchy. Verify the relationship through `gh api repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues` and `gh api repos/<OWNER>/<REPO>/issues/<CHILD-ISSUE-NUMBER>/parent`; stop if any child is not a real sub-issue. Add the Issues to the configured GitHub Project and set their configured `Workflow Status` to `Planned`. Put the complete split-plan contract in each child Issue body. Also create or overwrite `docs/plans/<plan-set-id>/plans.md` as a Korean split-plan index containing parent/child Issue links, slice summaries, dependencies, related Specs, and diagram links; GitHub remains the status source. local-markdown mode: create one ticket file and one matching plan document per split slice in the configured directory with status `planned`, plus `docs/plans/<plan-set-id>/plans.md` as its backlink index.
8. Store blocking edges in that same selected tracker.
9. Capture the current session branch and `HEAD` using the rules below, create the new plan-set branch from that fixed base ref, and push it to the remote. Do not assume or switch to `origin/main`.
10. In GitHub mode, after every split plan has been created, linked, and set to `Planned`, run `gh-open-pr` to create or update a draft plan PR against the captured session base branch. Include the parent Issue, all child Issues, dependencies, Product Spec, Architecture Spec, available diagram links, planning validation, and captured base branch. Diagram links are optional: link only available ticket-scoped SVG artifacts using the captured head branch; an absent diagram or explicit `해당 없음` is valid and must not block splitting or the draft PR. Do not add an Issue-closing trigger. If the pushed branch has no commits beyond the fixed base ref, report that GitHub cannot create the PR and stop before implementation handoff.
11. Hand off the approved context to `implement`.

## Branch Lineage

Capture branch lineage immediately before creating the plan-set branch:

1. Read the current session's current branch with `git branch --show-current`. Use that exact branch as the base branch without inferring dependency, PR state, or relation to the remote default branch.
2. Capture the current `HEAD` commit as the fixed base ref before switching or creating branches.
3. Create the new plan-set branch from that fixed base ref. Do not switch to the remote default branch or rebuild from `origin/main`.
4. In GitHub mode, push the captured base branch first when it has no remote ref, then push the new plan-set branch.
5. If the current session is detached or has uncommitted changes that prevent safe branch creation, stop and ask one Korean question explaining the exact condition. Do not choose another base branch.
6. Record the captured session base branch and fixed base ref in the plan-set handoff.

The resulting history must be:

```text
current session branch at captured HEAD
└── new plan-set branch
```

## Plan Representation

- GitHub Issues mode: use `references/github-issue-template.md` as the only parent/child body format. Validate rendered bodies before any GitHub mutation. The parent body must contain exact Product/Architecture Spec paths and a `명세와 다이어그램` section. Each applicable Product/Architecture diagram must be a non-empty, rendered ticket-scoped SVG Markdown image; do not put PlantUML source in the Issue body because GitHub Issue Markdown does not support PlantUML rendering. Each child Issue is one split plan. Its body must contain status, dependencies, implementation purpose, scope, acceptance criteria, test contract, related specs, and diagram disposition. Add links to relevant ticket-scoped SVG diagrams when they exist, with the head-branch-qualified URL required by `gh-open-pr`; if a diagram is absent, record `해당 없음` and its reason without treating it as a prerequisite. Keep `docs/plans/<plan-set-id>/plans.md` as a generated navigation/index document, not a second status source or duplicate full plan body. Every plan set owns its directory; never write a plan index directly under `docs/plans/`.
- local-markdown mode: create exactly one plan document per split slice at `docs/plans/<plan-set-id>/<plan-id>.md`. Keep `docs/plans/<plan-set-id>/plans.md` as an index only: it contains backlinks to the current individual plan documents, not full plan bodies. After approval, create or overwrite that plan-set directory and its index for the current ticket set; do not preserve or append prior entries or collapse plan bodies into it.
- In either mode, record slice-specific classes, relationships, states, and transitions when the slice changes them.
- Write a Korean implementation-purpose section in every plan representation. Explain clearly what the plan will implement and why, so the intended implementation is understandable without reading the Issue.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Do not mutate GitHub until every rendered body passes the template's heading, placeholder, link, and status checks.
- Parent Issue를 만들기 전에 실제 Product/Architecture Spec 파일과 연결할 모든 SVG 파일에 `test -s <path>`를 실행해 존재·비어 있지 않음을 확인한다.
- 실제 생성 body에는 `[경로]`, `<ticket-id>`, `<... SVG URL>` 같은 placeholder를 남기지 않는다.
- GitHub mode must create the parent/child hierarchy through GitHub's official Sub-issues API. `gh issue create --parent`, `gh issue edit --add-sub-issue`, and `gh issue edit --parent` are not supported `gh` CLI flags and must not be used. Create the child with `gh issue create`, obtain its numeric Issue `id`, attach it with `gh api --method POST repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues -F sub_issue_id=<CHILD-ISSUE-ID>`, and use `-F replace_parent=true` only when reparenting an existing child. Do not use a bare `#123` reference, task list, label, or related-issue link as a substitute.
- 연결 명령의 실행 형태는 다음 계약을 따른다:
  ```bash
  REPOSITORY=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  CHILD_ID=$(gh issue view "$CHILD_NUMBER" --json id -q .id)
  gh api --method POST "repos/$REPOSITORY/issues/$PARENT_NUMBER/sub_issues" \
    -H "Accept: application/vnd.github+json" \
    -F sub_issue_id="$CHILD_ID"
  gh api "repos/$REPOSITORY/issues/$PARENT_NUMBER/sub_issues" --jq ".[] | select(.number == $CHILD_NUMBER) | .number"
  gh api "repos/$REPOSITORY/issues/$CHILD_NUMBER/parent" --jq .number
  ```
- parent/child 관계를 Markdown 링크만으로 대체하지 않는다.
- If a child was created without a parent, repair it with the official Sub-issues API before continuing. Obtain the child Issue `id` with `gh issue view <CHILD-ISSUE-NUMBER> --json id -q .id`, then POST it to the parent's `/sub_issues` endpoint. Verify both directions with the parent's `/sub_issues` endpoint and the child's `/parent` endpoint.
- `spec-me → to-ticket`로 생성하는 parent/child Issue는 `tracker.github.assignees.spec_me`를 `SPEC_ME_ASSIGNEE`로 해석해 사용한다. 기본값은 `@me`다.
- Keep one Issue per split plan.
- Include policy-based unit tests and `ui ~ entity` e2e tests in every plan slice.
- Do not split only by layer.
- Do not write to a non-selected tracker. GitHub mode uses configured `Workflow Status`; local-markdown mode uses ticket status.
- Use the current spec and codebase summary as the source of truth.
- Diagram linking is required in the parent body when an applicable diagram exists. Inspect the ticket-scoped Product and Architecture diagram directories when available; link only existing non-empty SVG derivatives and never invent a path. If the spec says `해당 없음`, or no applicable diagram exists, record `해당 없음 — <reason>` in the parent section, preserve the plan purpose, scope, acceptance criteria, and test contract, and continue splitting.
- GitHub Issue Markdown supports Mermaid, GeoJSON, TopoJSON, and ASCII STL diagram syntaxes, not PlantUML. Use the rendered SVG image in the parent body; PlantUML 원문을 Issue body에 넣지 않는다. 근거: [GitHub Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) and [GitHub SVG support](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files).
- GitHub에서 보이도록 렌더된 SVG 이미지로 넣는다.
- 다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`을 기록한다. `해당 없음`은 계획 분할의 선행 조건이 아니며, 계획 목적과 검증 계약을 유지한 채 계속 진행한다.
- Always branch from the current session branch captured at `to-ticket` entry; never substitute a guessed default or predecessor branch.
