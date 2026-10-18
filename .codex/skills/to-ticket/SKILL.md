---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Model binding

Run the top-level planning context with the resolved `agents.high_performance_model` and `agents.high_performance_reasoning_effort` from `.codex/harness.yaml`. The workflow stage declares `model_tier: high_performance`. If the values are missing or unavailable, stop and require `setup`; do not inherit an unrelated parent model.

## Flow

1. At entry, resolve the absolute active session worktree with `git rev-parse --show-toplevel`, capture it as `session_worktree`, and verify the current branch, `HEAD`, and porcelain status there. 관리형 spec-me에서 넘긴 경로가 제거되었다면 보존 branch로 새 소유 worktree를 만들고 branch/HEAD/산출물을 확인한다. 새 session_worktree는 새 실제 루트이며 제거된 경로와 동일할 것을 요구하지 않는다. Pass this exact path to every agent/tool that accesses repository files and explicitly set every command's working directory to it; a previous command's working directory is not inherited by later calls.
2. Run `code-research` to get the current codebase baseline in compact form, with `session_worktree` as its repository root and working directory.
3. Split the spec into smart-zone vertical slices.
4. Attach policy/domain verification and `ui ~ entity` E2E contracts appropriate to each slice. Reuse existing meaningful tests; when a surface or business behavior is unaffected, record `해당 없음` and the reason instead of creating tests to fill a template.
5. Define dependencies between slices.
6. Present the split plan to the user and wait for approval before any mutation.
7. 승인 후 `session_worktree`에서 `bd version`, `bd where`, `bd status`를 실행해 Beads CLI와 초기화된 workspace가 있는지 확인한다. CLI나 workspace가 없으면 tracker ticket 또는 로컬 ticket 파일을 만들지 말고 `$setup`을 안내한다. 이 단계에서 database를 초기화하지 않는다. 이어서 `.codex/harness.yaml`을 읽어 tracker mode를 확인한다. 이 workflow가 생성하는 모든 ticket은 tracker mode와 관계없이 Beads에도 기록한다.
8. 어느 쪽에서도 ticket을 만들기 전에 대응하는 Beads issue를 생성하거나 기존 항목을 재사용한다. `harness_plan_id`는 parent에 `$PLAN_SET_ID:parent`, 각 child에 `$PLAN_SET_ID:$TICKET_ID`처럼 안정적으로 지정한다. `bd list --all --json --metadata-field "harness_plan_id=$BEADS_PLAN_ID"`로 먼저 검색해 결과가 하나면 재사용하고, 중복 결과가 있으면 중단한다. Beads 항목은 `bd create --title "$TITLE" --description "$DESCRIPTION" --type "$BEADS_TYPE" --metadata "{\"harness_plan_id\":\"$BEADS_PLAN_ID\"}" --json`으로 만들고, 반환된 `id`를 보존한다. GitHub mode에서는 parent를 `epic`으로 만들고 child에는 `--parent <beads-parent-id>`를 지정한다. `local-markdown` mode에서는 로컬 ticket마다 Beads issue를 하나씩 만들며 별도 parent는 만들지 않는다. 각 Beads description에는 ticket 제목, 구현 목적, 범위, acceptance criteria, test contract를 담는다. 선택한 tracker에서 ticket 생성과 초기 `Planned`/`planned` 상태 설정에 성공하면 대응 Bead에 `bd update <id> --external-ref <ref> --set-metadata harness_tracker_version=1 --set-metadata harness_classification=committed --set-metadata harness_phase=planning`을 실행한다. `<ref>`는 GitHub의 `owner/repo#number` 또는 configured directory 안의 로컬 ticket 상대 경로다. 그 뒤 `harness-tracker.mjs sync --ticket <ref>`로 재조회·반영한다. tracker 생성 전에는 version marker를 붙이지 않는다. 로컬 ticket 상태는 정확히 하나의 YAML frontmatter `status: planned` 필드로 기록한다. 의존성은 `bd dep add <beads-ticket-id> <depends-on-beads-id>`로 Beads에도 반영한다. Beads 기록에 실패하면 선택 tracker의 ticket 생성을 시작하지 않는다. Beads 생성 후 tracker 생성이 실패하면 Beads 항목을 삭제하지 말고, tracker 참조가 없는 항목은 `external-ref`를 비워둔 채 재시도 시 `harness_plan_id`로 찾아 연결한다.
9. 설정된 tracker에 canonical ticket을 생성한다. 이후 lifecycle 상태는 해당 tracker가 기준이며, Beads는 ticket과 상태를 공유 보드에 mirror한다.
10. GitHub mode: read `references/github-issue-template.md`, render one parent Issue and one child Issue per split slice, validate each rendered body against the template, then create the parent Issue. Parent Issue body must include `## 명세와 다이어그램`, exact Product/Architecture Spec paths, and every applicable ticket-scoped diagram as a rendered SVG Markdown image. GitHub Issue Markdown does not list PlantUML as a supported diagram syntax; use SVG images, not PlantUML source. For the `spec-me → to-ticket` flow, resolve `tracker.github.assignees.spec_me` to `SPEC_ME_ASSIGNEE` (default `@me`) and pass `--assignee "$SPEC_ME_ASSIGNEE"` when creating the parent and all children. GitHub CLI has no native `--parent` or `--add-sub-issue` flag, so create each child with normal `gh issue create`, capture its numeric Issue `id`, then attach it through GitHub's official REST API: `gh api --method POST repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues -F sub_issue_id=<CHILD-ISSUE-ID>`. For an already-created child, use the same API with `-F replace_parent=true` when reparenting is required. Markdown links in the body or the plan-set's `docs/plans/<plan-set-id>/plans.md` are supplemental navigation only and do not establish the hierarchy. Verify the relationship through `gh api repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues` and `gh api repos/<OWNER>/<REPO>/issues/<CHILD-ISSUE-NUMBER>/parent`; stop if any child is not a real sub-issue. Add the Issues to the configured GitHub Project and set their configured `Workflow Status` to `Planned`. Put the complete split-plan contract in each child Issue body. Also create or overwrite `docs/plans/<plan-set-id>/plans.md` as a Korean split-plan index containing parent/child Issue links, slice summaries, dependencies, related Specs, and diagram links; GitHub remains the status source. local-markdown mode: create one ticket file and one matching plan document per split slice in the configured directory with status `planned`, plus `docs/plans/<plan-set-id>/plans.md` as its backlink index.
11. blocking edge는 선택한 tracker에 기록하고, 위와 같이 Beads에도 반영한다.
12. 모든 계획 산출물은 현재 세션 worktree와 진입 시 확인한 세션 브랜치에 둔다. 관리형 `spec-me` 세션에서는 이미 Spec 커밋이 있는 브랜치를 이어서 사용한다. 별도 plan-set 브랜치를 만들거나, 브랜치를 전환하거나, 원격에 푸시하지 않는다. 해당 세션 브랜치를 downstream 구현의 기준으로 보존한다. workflow 종료 시 worktree는 제거하며 downstream execution_line 경로는 이 branch로 새로 생성한다.
13. `to-ticket`에서는 계획 PR을 만들지 않는다. GitHub mode의 최종 PR은 모든 분할 계획의 구현이 끝나고 결과가 `execution_line`에 통합된 뒤 downstream 구현 workflow에서 만든다.
14. 승인된 맥락을 절대 경로 `session_worktree`, 캡처한 세션 브랜치, `execution_line`과 함께 `implement`에 인계한다. 인계 전에 계획 파일을 확인하고 종료 cleanup 후 branch/HEAD/recovery_path/return_root를 함께 전달한다. 삭제된 session_worktree 경로를 downstream cwd로 전달하지 않는다.
15. 종료 직전 `before_complete` lifecycle hook에 `plans_index: { workspace_root: session_worktree, plan_set_id }` 증거를 전달한다. 설치된 프로젝트에서는 `node .codex/scripts/plans-index-gate.mjs --workspace-root <session_worktree> --plan-set-id <plan-set-id>`를 실행해 같은 검사를 수행한다. `docs/plans/<plan-set-id>/plans.md`가 일반 파일이고 비어 있지 않아야 통과한다. 누락 또는 빈 파일이면 완료 판정은 실패하므로, 파일을 생성한 뒤 다시 검증한다.

## 작업 루트 전달과 검증

- `session_worktree`는 `to-ticket` 시작 시 확정하는 필수 실행 경로다. `spec-me`에서 인계받았다면 전달된 값과 실제 저장소 루트가 같아야 한다.
- `code-research` 또는 파일·tracker 변경 작업을 시작하기 직전에 `session_worktree`를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <session_worktree> --json`을 실행한다. 결과의 `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 실패하면 하위 단계/agent를 시작하지 않는다. 각 위임 호출에는 `cwd`와 `workspace_root`를 동일한 절대 경로로 전달한다.
- 코드 조사, 파일 읽기/쓰기, branch 명령, `gh-open-pr` 등 저장소 경로를 사용하는 모든 단계에 이 루트를 명시한다. 산출 plan 경로가 루트 안에 있는지 확인한 후 `implement`에 동일한 경로를 인계한다.

## 브랜치 계보

1. 진입 시점에 확인한 현재 세션 브랜치와 `HEAD`를 계획 작업의 기준으로 기록한다.
2. `spec-me`에서 인계받은 경우 전달된 기존 `session_branch`를 유지하되, 제거된 worktree 경로는 같은 branch의 새 소유 worktree로 대체한다. 이 브랜치에는 이미 Spec 커밋이 있으므로 계획을 위해 별도 브랜치를 만들지 않는다.
3. 계획 파일은 같은 `session_worktree`와 세션 브랜치에 둔다. 브랜치를 생성하거나 전환하거나 원격에 푸시하지 않는다.
4. `session_branch`를 downstream 구현의 `execution_line`으로 전달한다. 구현 워크플로우는 각 계획의 작업 브랜치를 이 실행 라인에 통합하고, 모든 계획이 끝난 뒤 최종 PR을 만든다.
5. 관리형 `spec-me` 세션이 아닌 직접 실행에서도 현재 브랜치를 유지한다. detached HEAD라면 브랜치 계보를 보장할 수 없으므로 진행하지 말고 구체 조건을 한국어로 설명한다.

예상 계보:

```text
spec-me session branch (Specs + plans; downstream execution_line)
├── split-plan implementation branch 1
├── split-plan implementation branch 2
└── final PR from session branch after integration
```

## Plan Representation

Read [execution-evidence.md](references/execution-evidence.md) before splitting. Preserve each slice's UC/BR/INV/target IDs, existing domain owner and enforcement point, verification command, and relevant workload/baseline/regression criteria in the existing acceptance/test-contract fields. Keep the accepted DDD model/communication/deployment delta linked. A performance-irrelevant slice records a reason instead of adding a benchmark. Do not introduce new tracker headings or unsupported structured-source keys.

- GitHub Issues mode: use `references/github-issue-template.md` as the only parent/child body format. The Issue form's `structured-source` field is the only canonical input: `preparePlanSetIssue` must validate its YAML/JSON with `validatePlanSetSource`, render with `renderPlanSetIssue`, and `trackerCreatePlanSetIssue` must pass only that result to the external tracker port before any GitHub mutation. The other form fields are human-readable previews and must not become a second source. Validate rendered bodies before any GitHub mutation. The parent body must contain exact Product/Architecture Spec paths and a `명세와 다이어그램` section. Each applicable Product/Architecture diagram must be a non-empty, rendered ticket-scoped SVG Markdown image; do not put PlantUML source in the Issue body because GitHub Issue Markdown does not support PlantUML rendering. Each child Issue is one split plan. Its body must contain status, dependencies, implementation purpose, scope, acceptance criteria, test contract, related specs, and diagram disposition. Add links to relevant ticket-scoped SVG diagrams when they exist, with the head-branch-qualified URL required by `gh-open-pr`; if a diagram is absent, record `해당 없음` and its reason without treating it as a prerequisite. Keep `docs/plans/<plan-set-id>/plans.md` as a generated navigation/index document, not a second status source or duplicate full plan body. Every plan set owns its directory; never write a plan index directly under `docs/plans/`.
- local-markdown mode: create exactly one plan document per split slice at `docs/plans/<plan-set-id>/<plan-id>.md`. Keep `docs/plans/<plan-set-id>/plans.md` as an index only: it contains backlinks to the current individual plan documents, not full plan bodies. After approval, create or overwrite that plan-set directory and its index for the current ticket set; do not preserve or append prior entries or collapse plan bodies into it.
- In either mode, record slice-specific classes, relationships, states, and transitions when the slice changes them.
- `system-targets.yaml`에 `decision_metadata.decision_layer_version: 1`이 있는 ticket은 분할 전에 `node .codex/scripts/harness-decision-gate.mjs decision_evidence_complete --ticket <ticket-id>`와 `node .codex/scripts/harness-decision-gate.mjs decision_review_complete --ticket <ticket-id>`를 실행한다. `decision_metadata.decision_ids`의 모든 항목은 구조가 유효하고 승인된 Architecture Decision 및 일곱 checklist 항목이 모두 통과한 승인 ReviewRecord에 연결되어야 한다. 승인된 Decision ID와 함께 연결된 System Target, approved Principle, approved durable Evidence 참조를 parent architecture context와 관련 child plan 범위에 보존한다. `review_required` Decision은 해당 topic이 재검토되고 gate가 통과할 때까지 accepted decision handoff로 취급하지 않는다. 표식이 없으면 두 gate는 기존 계획 계약을 그대로 허용하며 decision artifact를 요구하지 않는다.
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
- Include policy-based unit and `ui ~ entity` E2E verification dispositions in every plan slice. A disposition may reuse an existing command or explain why that verification is not applicable; it does not mandate new tests or a new UI/runtime for an internal change.
- Do not split only by layer.
- 선택하지 않은 configured tracker에는 기록하지 않는다. 단, `to-ticket`은 ticket을 Beads에 mirror하고 `implement`는 lifecycle 상태를 Beads에 동기화한다. GitHub mode는 설정된 `Workflow Status`, `local-markdown` mode는 ticket 파일의 status를 canonical 기준으로 삼는다.
- Use the current spec and codebase summary as the source of truth.
- Diagram linking is required in the parent body when an applicable diagram exists. Inspect the ticket-scoped Product and Architecture diagram directories when available; link only existing non-empty SVG derivatives and never invent a path. If the spec says `해당 없음`, or no applicable diagram exists, record `해당 없음 — <reason>` in the parent section, preserve the plan purpose, scope, acceptance criteria, and test contract, and continue splitting.
- GitHub Issue Markdown supports Mermaid, GeoJSON, TopoJSON, and ASCII STL diagram syntaxes, not PlantUML. Use the rendered SVG image in the parent body; PlantUML 원문을 Issue body에 넣지 않는다. 근거: [GitHub Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) and [GitHub SVG support](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files).
- GitHub에서 보이도록 렌더된 SVG 이미지로 넣는다.
- 다이어그램이 없으면 링크를 생략하고 `해당 없음 — <reason>`을 기록한다. `해당 없음`은 계획 분할의 선행 조건이 아니며, 계획 목적과 검증 계약을 유지한 채 계속 진행한다.
- `to-ticket` 진입 시 캡처한 현재 세션 브랜치에서 계획을 이어간다. plan-set 브랜치를 만들거나 추측한 기본 브랜치로 바꾸지 않는다.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 종료 정리

`session-worktree`의 소유권 등록과 모든 종료 경로 규칙을 적용한다. 진입 때 이전 경로가 제거됐다면 보존한 branch로 새 worktree를 만든다. 정상 완료 명령과 실패/사용자 중단/handoff의 finish는 archive·검증 후 소유 worktree를 제거한다. 원래 사용자 workspace는 자동으로 소유하거나 삭제하지 않는다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## Spec 적대적 리뷰 인계 gate

계획 작성·tracker 변경 전에 `spec-review`의 최신 Product/Architecture 리뷰를 확인한다. 전달된 ticket_id·spec_reviews를 새 workspace의 현재 request/Spec/diagram/용어/계약/source hash로 검사한다. 누락·stale·중대 finding·작성자와 동일 reviewer는 차단하고 spec-me 리뷰로 돌아간다. 기존 Spec의 pass를 추정하거나 legacy 데이터를 자동 승인하지 않는다. 정상 완료 state에도 동일 ticket_id/spec_reviews를 전달한다.
