---
name: to-ticket
description: Split approved product and architecture specifications into vertical implementation tickets and plans.
---

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [code-research](../../../.codex/internal-skills/code-research/GUIDE.md) · [implement](../../../.codex/internal-skills/implement/GUIDE.md) · [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md) · [spec-review](../../../.codex/internal-skills/spec-review/GUIDE.md) · [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md) · [testing-guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md).

# to-ticket

## What it does

`to-ticket` is the public entrypoint for turning Product Spec and Architecture Spec into vertical implementation slices. It recommends a clean split, waits for approval, and then prepares the Issue and plan structure needed for execution.

## Model binding

Run the top-level planning context with the resolved `agents.high_performance_model` and `agents.high_performance_reasoning_effort` from `.codex/harness.yaml`. The workflow stage declares `model_tier: high_performance`. If the values are missing or unavailable, stop and require `setup`; do not inherit an unrelated parent model.

For test planning, read `<shared_guidance_root>/docs/agents/testing-guidance.md` from the original project root (`return_root`) and pass applicable entries into each plan. Do not use a branch-local copy in a managed worktree; verify the shared root uses the same Git common directory as `workspace_root`.

## Flow

1. At entry, resolve the absolute active session worktree with `git rev-parse --show-toplevel`, capture it as `session_worktree`, and verify the current branch, `HEAD`, and porcelain status there. 관리형 spec-me에서 넘긴 경로가 제거되었다면 보존 branch로 새 소유 worktree를 만들고 branch/HEAD/산출물을 확인한다. 새 session_worktree는 새 실제 루트이며 제거된 경로와 동일할 것을 요구하지 않는다. Pass this exact path to every agent/tool that accesses repository files and explicitly set every command's working directory to it; a previous command's working directory is not inherited by later calls.
2. Run `code-research` to get the current codebase baseline in compact form, with `session_worktree` as its repository root and working directory.
3. Split the spec into smart-zone vertical slices.
4. Read the [공통 검증 정책](../e2e-test/references/verification-policy.md). Default each slice to focused unit/integration/contract verification. Plan E2E only for explicit requests for E2E/full-stack/browser end-to-end execution or changed critical cross-boundary paths whose failure cheaper checks cannot establish. A UI change alone does not require full-stack E2E. Preserve the existing E2E disposition field; use `해당 없음 — 사유, 선택한 저비용 검증` when appropriate.
5. Define dependencies between slices.
6. Present the split plan to the user and wait for approval before any mutation.
7. 승인 후 `session_worktree`에서 `bd version`, `bd where`, `bd status`를 실행해 Beads CLI와 초기화된 workspace가 있는지 확인한다. CLI나 workspace가 없으면 ticket을 만들지 말고 `$setup`을 안내한다. database를 초기화하지 않는다. `.codex/harness.yaml`에서 tracker mode를 확인한다. 모든 ticket은 tracker mode와 관계없이 Beads에도 기록한다.
8. Beads issue를 생성하거나 기존 항목을 재사용한다. `harness_plan_id`는 parent에 `$PLAN_SET_ID:parent`, child에 `$PLAN_SET_ID:$TICKET_ID`처럼 안정적으로 지정하고, `bd list --all --json --metadata-field "harness_plan_id=$BEADS_PLAN_ID"`로 먼저 확인한다. 중복 결과는 중단한다. GitHub mode에서는 parent를 `epic`으로 만들고 child에 `--parent <beads-parent-id>`를 지정한다. 각 description에는 제목, 구현 목적, 범위, acceptance criteria, test contract를 담는다. `bd dep add <beads-ticket-id> <depends-on-beads-id>`로 의존성도 기록한다. 이 단계에서 external_ref와 lifecycle marker를 붙이지 않는다. Beads 기록 실패 시 계획을 중단한다.
9. 사용자 승인 뒤 모든 canonical 계획을 작성한다. 각 child의 complete plan은 `docs/plans/<plan-set-id>/<plan-id>.md`에 두고, `plans.md`는 로컬 plan 링크·요약·의존성만 담는 index로 작성한다. GitHub mode에서도 이 per-plan 문서가 리뷰 대상이자 게시 전 canonical source다. Issue 제목·본문 초안과 structured-source는 `<session_directory>/runtime/to-ticket/drafts/`에 저장한다. GitHub에서 아직 조회하지 않은 issue number/link를 추측하지 않는다.
10. 전체 source 규칙을 `docs/plans/<plan-set-id>/traceability.json`에 기록하고 requirement를 canonical per-plan 문서에 연결한다. 모든 계획에 requirement IDs, acceptance criteria, counterexamples, verification cases를 담는다. traceability snapshot을 만든 뒤 작성 맥락을 상속하지 않는 `plan_reviewer`가 전체 source와 계획을 직접 리뷰한다. blocker/major 수정 후에는 새 reviewer로 재검토하고 snapshot을 갱신한다. `check --phase planning`, plans-index gate, spec-review check까지 통과시킨다. 이 리뷰와 gate가 끝날 때까지 GitHub Issue/Project API를 호출하거나 Issue/Project 상태를 조회·변경하지 않는다.
11. 모든 계획과 리뷰 gate가 통과한 뒤에만 tracker에 발행한다. `local-markdown` mode는 이 시점에 ticket 파일을 `planned` 상태로 만들고 index를 갱신한다. GitHub mode는 [GitHub batch publish](references/github-batch-publish.md)의 단일 publish phase로 parent/child Issues 생성, Project 등록, `Workflow Status: Planned` 설정, 최종 상태 조회를 수행한다. publish 중 일부만 성공하면 기존 Issue를 다시 만들지 않는다. 각 API 응답을 `<session_directory>/runtime/to-ticket/publish-state.json`에 보존하고 완료되지 않은 단계만 재개한다.
12. GitHub 발행이 확인된 뒤 Beads 항목에 `external_ref`, `harness_tracker_version=1`, `harness_classification=committed`, `harness_phase=planning`을 연결한다. 초기 발행에서 ticket별 `harness-tracker sync`를 실행하지 않는다. 완료 state의 `tracker_sync.ticket_refs`에 이 plan set의 parent와 모든 child `owner/repo#number`를 넣는다. 완료 lifecycle gate는 이 목록만 batch 조회해 Beads mirror와 대조한다. 목록을 빠뜨리면 기존 전역 검사가 실행되므로 누락하지 않는다. 실패 시 완료를 차단한다.
13. blocking edge는 선택한 tracker와 Beads 양쪽에 기록한다. GitHub mode는 batch publish의 parent-child 연결을 사용한다.
14. 모든 산출물은 진입 시 확인한 session branch에 둔다. 관리형 `spec-me` 세션에서는 기존 Spec branch를 이어간다. branch를 새로 만들거나 전환하거나 원격에 push하지 않는다. 종료 시 branch/HEAD/recovery_path/return_root를 보존해 `implement`에 인계한다.
15. `to-ticket`에서는 계획 PR을 만들지 않는다. GitHub mode의 최종 PR은 downstream 구현에서 모든 분할 계획을 통합한 후 만든다.

## 작업 루트 전달과 검증

- `session_worktree`는 `to-ticket` 시작 시 확정하는 필수 실행 경로다. `spec-me`에서 인계받았다면 전달된 값과 실제 저장소 루트가 같아야 한다.
- `code-research` 또는 파일 변경 작업을 시작하기 직전에 `session_worktree`를 `cwd`로 지정해 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <session_worktree> --defer-tracker-sync --json`을 실행한다. `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다. 이 flag는 계획 리뷰 전 GitHub tracker query를 미루며, `tracker_sync`는 publish 후 완료 gate에서 batch 검사한다. 실패하면 하위 단계/agent를 시작하지 않는다. 각 위임 호출에는 `cwd`와 `workspace_root`를 동일한 절대 경로로 전달한다.
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

- GitHub Issues mode: use `references/github-issue-template.md` as the only parent/child body format and the reviewed per-plan files as the canonical plan content. Validate all locally rendered draft bodies before publish. The Issue form's `structured-source` remains the sole canonical input when that form is used: `preparePlanSetIssue` validates it with `validatePlanSetSource` and `renderPlanSetIssue` renders it; preview fields never override it. The parent body must contain exact Product/Architecture Spec paths and a `명세와 다이어그램` section. Each applicable Product/Architecture diagram must be a non-empty rendered ticket-scoped SVG Markdown image; do not put PlantUML source in the Issue body. Each child Issue is one split plan and includes status, dependencies, implementation purpose, scope, acceptance criteria, test contract, related specs, and diagram disposition. Include applicable ticket-scoped SVG links with the head-branch-qualified URL required by `gh-open-pr`; otherwise record `해당 없음` and its reason. `plans.md` is only the generated navigation index, not a status source or duplicate plan body. Update its parent/child Issue URLs after publication without changing reviewed per-plan content. Every plan set owns its directory; never write a plan index directly under `docs/plans/`.
- local-markdown mode: create exactly one plan document per split slice at `docs/plans/<plan-set-id>/<plan-id>.md`. Keep `docs/plans/<plan-set-id>/plans.md` as an index only: it contains backlinks to the current individual plan documents, not full plan bodies. After approval, create or overwrite that plan-set directory and its index for the current ticket set; do not preserve or append prior entries or collapse plan bodies into it.
- In either mode, record slice-specific classes, relationships, states, and transitions when the slice changes them.
- `system-targets.yaml`에 `decision_metadata.decision_layer_version: 1`이 있는 ticket은 분할 전에 `node .codex/scripts/harness-decision-gate.mjs decision_evidence_complete --ticket <ticket-id>`와 `node .codex/scripts/harness-decision-gate.mjs decision_review_complete --ticket <ticket-id>`를 실행한다. `decision_metadata.decision_ids`의 모든 항목은 구조가 유효하고 승인된 Architecture Decision 및 일곱 checklist 항목이 모두 통과한 승인 ReviewRecord에 연결되어야 한다. 승인된 Decision ID와 함께 연결된 System Target, approved Principle, approved durable Evidence 참조를 parent architecture context와 관련 child plan 범위에 보존한다. `review_required` Decision은 해당 topic이 재검토되고 gate가 통과할 때까지 accepted decision handoff로 취급하지 않는다. 표식이 없으면 두 gate는 기존 계획 계약을 그대로 허용하며 decision artifact를 요구하지 않는다.
- Write a Korean implementation-purpose section in every plan representation. Explain clearly what the plan will implement and why, so the intended implementation is understandable without reading the Issue.

## Rules

- Do not mutate GitHub or local plan files before approval.
- Do not call the GitHub Issue/Project API until every plan body, traceability check, and fresh review has passed. Do not edit canonical plan content after review; only resolve generated Issue URLs and numbers during the publish phase.
- Validate rendered bodies before any GitHub mutation; validate draft bodies before publish and recheck only the generated Issue-number/link substitution during batch publish.
- Parent Issue를 만들기 전에 실제 Product/Architecture Spec 파일과 연결할 모든 SVG 파일에 `test -s <path>`를 실행해 존재·비어 있지 않음을 확인한다.
- 실제 생성 body에는 `[경로]`, `<ticket-id>`, `<... SVG URL>` 같은 placeholder를 남기지 않는다.
- GitHub mode creates real parent/child Issues through GitHub's official REST API. Unsupported CLI forms `gh issue create --parent`, `gh issue edit --add-sub-issue`, and `gh issue edit --parent` must not be used. Read [GitHub batch publish](references/github-batch-publish.md): it creates children with `parent_issue_id`, uses create responses instead of per-Issue `gh issue view`, batches Project add/status mutations, and leaves the final `tracker_sync` gate to batch-verify all Issue statuses. For recovery of a legacy parentless child only, use the official `gh api --method POST repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues -F sub_issue_id=<CHILD-ISSUE-ID>` endpoint and verify the parent list once. In that recovery only, obtain the numeric child ID with `CHILD_ID=$(gh issue view "$CHILD_NUMBER" --json id -q .id)`; a regular publish uses the create response and never runs `gh issue view` per ticket. The child `/parent` read is a legacy repair check, not part of regular batch verification.
- Legacy parentless-child repair only:
  ```bash
  REPOSITORY=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  CHILD_ID=$(gh issue view "$CHILD_NUMBER" --json id -q .id)
  gh api --method POST "repos/$REPOSITORY/issues/$PARENT_NUMBER/sub_issues" -H "Accept: application/vnd.github+json" -F sub_issue_id="$CHILD_ID"
  gh api "repos/$REPOSITORY/issues/$PARENT_NUMBER/sub_issues" --jq ".[] | select(.number == $CHILD_NUMBER) | .number"
  gh api "repos/$REPOSITORY/issues/$CHILD_NUMBER/parent" --jq .number
  ```
- parent/child 관계를 Markdown 링크만으로 대체하지 않는다.
- Verify all child relationships in one parent `/sub_issues` REST read after publication; do not issue a separate parent lookup for every child.
- `spec-me → to-ticket`로 생성하는 parent/child Issue는 `tracker.github.assignees.spec_me`를 `SPEC_ME_ASSIGNEE`로 해석해 사용한다. 기본값은 `@me`다.
- Keep one Issue per split plan.
- Include focused verification and an E2E disposition in the existing plan/test-contract strings. E2E plans must state the changed requirement/risk, why lower-level checks are insufficient, minimal scenarios and observable oracle, execution profile, timeout, and bounded total attempt budget. For unchanged boundaries or internal/documentation-only work, normally record `해당 없음 — 사유, 선택한 저비용 검증`. If an approved plan requires E2E but the current scope appears inconsistent, propose an evidence-based plan amendment before execution; never silently skip it.
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
