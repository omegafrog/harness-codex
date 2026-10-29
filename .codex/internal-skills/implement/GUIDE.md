<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [ddd-design](../ddd-design/GUIDE.md) · [implementation-guidance](../implementation-guidance/GUIDE.md) · [session-worktree](../session-worktree/GUIDE.md) · [spec-review](../spec-review/GUIDE.md) · [sync-contracts](../sync-contracts/GUIDE.md) · [testing-guidance](../testing-guidance/GUIDE.md).

# implement

## 실행 모델과 반환

기본 `model_tier`는 `implementation`이며 `agents.implementation_model`와 `agents.implementation_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

구현 전 workspace 확인은 workflow runtime dispatch의 `before_dispatch` workspace gate가 수행한다. skill 절차와 구현 agent는 `harness-workspace-preflight.mjs`를 별도로 실행하지 않는다. gate 실패는 spawn을 막고 정확한 결과를 caller에게 반환한다. 구현 agent는 setup 복구 절차를 호출하지 않는다.


Before editing code, activate the installed Ponytail plugin's `ponytail` skill in its default `full` mode and follow its minimal-change guidance throughout implementation. If it is unavailable, stop and report the missing/disabled plugin instead of silently proceeding without it.

## Harness source distribution

When implementing a Harness feature or runtime change in the Harness source repository, trace it through managed asset discovery and transforms, fresh installation, update, Doctor inventory/diagnostics, and Git ignore rules (`.git/info/exclude` or `.gitignore`, according to ownership). Change the installer and Doctor wherever the new or changed behavior requires it. Add an installed-consumer regression check that verifies the behavior and `git status`: Harness-owned generated files stay out of commits while application-owned changes remain visible and untouched. Source-only tests do not prove the feature reaches installed projects. Keep consumer-owned project guidance and configuration out of forced managed assets unless the installer explicitly treats them as safe templates.

Before workspace cleanup after installation or update, inspect and classify every path in `git status --short`. Synchronize ignore entries for Harness-managed generated paths through the installer and verify them with `git check-ignore -v`. Keep project-owned preparation files such as `docs/agents/EXEC.md`, `docs/agents/execution.json`, and `docs/contracts/**` visible and preserve their edits. Back up all changed and untracked paths before cleanup; tracked modifications remain vulnerable to restore/reset operations regardless of ignore rules. Remove only individually confirmed Harness-generated paths, then verify the backup and final Git status.

## Flow

Require the caller's absolute `shared_guidance_root` (the original project root, `return_root` for managed worktrees) and verify it shares the same Git common directory as `workspace_root`. Read `<shared_guidance_root>/docs/agents/implementation-guidance.md` before planning/editing and `<shared_guidance_root>/docs/agents/testing-guidance.md` before planning, writing, modifying, selecting, or running any test. Follow the reusable [test-writing guidance](../testing-guidance/GUIDE.md) as well. Never read worktree-local copies; those may be stale. Apply only in-scope guidance and surface conflicts with the approved Spec or execution contract before proceeding. Also read the affected [model continuity contract](../ddd-design/references/model-continuity.md), plan's [execution evidence contract](../../../.agents/skills/to-ticket/references/execution-evidence.md), and [shared verification policy](../../../.agents/skills/e2e-test/references/verification-policy.md). Before editing, confirm existing model/owner and requirement IDs, record any relevant pre-change baseline, and use the current public domain operation. Reject new modules/scaffolding without the approved boundary rationale. Preserve verification and measurement results in the existing checkpoint `tests` payload, and hand them to both reviewers. Before completion, reconcile actual model/code and verification-map changes; do not relabel an accepted target as implemented before its behavior is verified.

## 실행 방식별 작업 위치

orchestrator가 확정한 `workspace_root`에서 구현한다. 소유 worktree의 branch·등록·복구 정보는 `session_directory/worktree.json`에서 확인한다. 순차/병렬 배정과 worktree 생성·통합·종료는 orchestrator의 책임이다. 구현 worker가 실행 방식을 다시 고르거나 lifecycle 정보를 중복 전달하지 않는다.

모든 명령은 전달받은 절대 `workspace_root`를 cwd로 지정한다. 파일 접근 전에 `pwd`와 `git rev-parse --show-toplevel`을 대조하고, 완료 결과에 확인한 루트와 브랜치를 보고한다.

1. Read `.codex/harness.yaml` and resolve the selected tracker mode. Before implementation dispatch, require an actual `agents.implementation_model` value; before runtime/E2E verification, resolve and explicitly pass actual `agents.execution_model` and `agents.execution_reasoning_effort` values. Missing values stop the workflow and require `setup`; never inherit the parent model.
2. Resolve exactly one approved, executable split plan:
   - GitHub Issues: select a child Issue from the parent plan-set Issue, move its configured GitHub Project `Workflow Status` to `In Progress`, and use its Issue body as the plan.
   - local-markdown: resolve one ticket from the configured directory and set its status to `in-progress`; confirm the plan-set's `docs/plans/<plan-set-id>/plans.md` links to the plan document.
   - 새 v1 mirror는 `beads` 스킬의 공통 `harness-tracker.mjs sync --ticket <external_ref> --status in-progress --phase implementation --classification committed`로 canonical과 Beads를 함께 변경·재조회한다. 개별 gh/bd status 호출을 조립하지 않는다. version marker가 없는 기존 데이터는 이전/자동 연결하지 않는다.
   - Read the Product and Architecture Specs and the exact canonical plan selected by the passing plan-review gate before editing. The plan’s test contract defines business-logic unit tests and verification; do not infer additional test suites. Missing or stale planning review blocks dispatch. Keep ticket existence, canonical tracker status, and planning-review approval distinct: a status read failure or dirty/uncommitted Spec does not prove the ticket or approved plan is absent. Cite the exact missing or stale Spec, plan, or review input; report any separate cleanliness rule with its own evidence.
3. Resolve the ticket-scoped Product Spec and Architecture Spec.
4. Read `docs/architecture/constraints.md` when present, then reload the current spec, resolved plan representation, and Git state.
5. Read the explicit `workspace_root` passed by `implement-wrapper`; do not infer it from a prior command or the parent session's default directory. Set every command's working directory to that root and verify `pwd` plus `git rev-parse --show-toplevel` before reading or editing plan files. Stop before editing if they do not match. Capture the pre-implementation `HEAD` there as the code-review fixed point, then execute the plan in that workspace.
6. 승인된 Product Spec의 UC/BR/AC와 Architecture Spec의 규칙 owner를 확인해 변경할 비즈니스 로직을 정한다.
7. 승인 Spec을 만족하는 최소 구현을 진행한다.
8. Before writing tests, read the canonical shared testing guidance and the reusable [test-writing guidance](../testing-guidance/GUIDE.md). For this split plan, write or update only business-logic unit tests for its owned rules; test important business outcomes without enumerating irrelevant type/format failures. Mock external dependencies. Tests must not depend on other tests, their order, or shared mutable state. If business logic changed, run the plan's unit tests in this implementation slot; if none changed, do not add unit tests.
9. Run the exact native CLI command in the reviewed ledger’s verification contract; confirm it covers every listed `verification_file`. Do not wrap ordinary unit/regression checks in `harness-exec`. Keep non-test process gates distinct from test creation, and report executed and omitted verification with reasons. Do not run feature-level E2E at an individual plan boundary.
10. Commit the result. A split plan never creates or updates its own PR. Do not set terminal tracker status before both independent review results pass.
11. `review_fixed_point`는 구현 시작 직전 캡처한 `HEAD`다. `code-review`를 이 fixed point에 대해 실행하고 Standards·Spec 두 독립 결과를 모두 수집한다. `standards_reviewer`에는 ticket-scoped Product Spec을, `spec_reviewer`에는 ticket-scoped Architecture Spec을 전달한다.
12. 두 리뷰의 결과를 모두 수집하고 `code-review`의 수정 판정 절차를 적용한다. 실행 중인 reviewer는 기다리고, 종료·누락된 reviewer는 사유를 보존해 같은 commit·fixed point의 fresh context에서 한 번 재시도한다. 구현 finding은 두 축의 지적을 모아 해당 규칙의 최초 요청·후속 요청·직접 API·재시도·저장 복구 경로와 검증 증거를 함께 확인한다. 수정 전에 `harness-code-review.mjs repair`로 plan별 수정 횟수를 예약하고 허용된 범위의 코드·테스트를 함께 고친다. 새 commit을 만든 뒤 원래 `review_fixed_point`부터 누적 diff를 서로 다른 fresh reviewer 2명이 검토한다. 기본 수정 한도는 1회이며 승인된 설정은 최대 2회다. 한도·요구 충돌·설계 결정 문제는 남은 지적과 필요한 결정을 사용자에게 제시하고 중단한다. 한도 초기화는 실제 수정 범위/설계 결정을 바꾸고 새 planning snapshot이 독립 검토·dispatch 검사를 통과한 경우에만 허용한다. “계속 해” 같은 일반 진행 지시는 초기화 근거가 아니다. 자동 판정이 repair adapter를 사용하는 경우에는 동일 예약 처리가 실행기에 연결된다.
13. 추가 작업이나 계획 범위 변경이 필요하면 현재 commit·리뷰 보고서·미해결 finding·검증 증거·`review_fixed_point`와 필요한 다음 작업을 checkpoint에 보존하고 공통 상태 코드로 반환한다. 재분할·재실행·context 인계 판단은 orchestrator가 설정 파일과 실행 근거로 결정한다.
14. 구현 finding이 새 명령·업무 상태·규칙·경계 또는 승인 Spec의 변경을 요구하면 code-review의 설계 변경 분기로 전환한다. 현재 구현 commit·fixed point·변경 필요 근거·모든 영향 경로와 재개 조건을 checkpoint에 보존하고 상위 caller에게 spec-me 및 영향 계획 재검토를 요청한다. 구현 repair 예약은 수정 가능한 범위가 승인된 뒤 수행한다.
   해결에 필요한 외부 환경, 권한, 의존성 또는 사용자/아키텍처 결정이 막혀 있으면 해당 리뷰 finding과 필요한 입력·정확한 unblock condition을 checkpoint 및 결과에 기록하고 선택한 tracker에서 ticket을 `Blocked`로 전환한다. v1 mirror의 차단은 `harness-tracker.mjs sync --ticket <ref> --status blocked`로 canonical과 Beads에 반영하고 검증한다. blocker 설명과 unblock condition은 기존 checkpoint에 보존한다. 입력이 해결되기 전에는 수정·재리뷰가 가능하다고 가장하거나 완료 처리하지 않는다.
15. 구현·검증 결과와 선택한 실행 profile의 성공 receipt를 기존 session evidence에 기록한다. ticket을 terminal state로 설정하기 전에 `plan-review` completion gate로 Spec·전체 계획의 review snapshot이 최신인지 확인한다. Receipt는 session runtime 경로에서 읽으며 profile/config/file hash가 현재 파일과 맞아야 한다.
16. 모든 blocking finding이 해소되고 두 리뷰 결과와 plan-review completion gate가 현재 commit에 대해 통과한 뒤에만 선택한 ticket을 terminal state로 설정한다: GitHub mode는 `Done`, local-markdown mode는 `completed`. GitHub mode에서는 child Issue를 열어 둔 채 configured `Workflow Status` Project field만 `Done`으로 갱신하고, 보고 전에 그 field가 `Done`인지 확인한다. v1 mirror는 `harness-tracker.mjs sync --ticket <ref> --status completed --phase review`로 canonical Done과 Beads closed를 반영·재조회한다. 이 공통 명령을 직접 gh/bd 갱신 대신 사용한다. Beads 갱신에 실패하면 canonical tracker 상태를 되돌리지 말고, mirror sync blocker를 보고해 재시도할 수 있게 한다.
17. Recalculate dependent tickets as soon as their dependencies reach those terminal states. Keep only incomplete or unresolved tickets waiting.
18. Stop and report the updated statuses and whether the next plan can run. Invoke or recommend `gh-open-pr` exactly once only when every split plan in the plan set has passed verification and reached its terminal status; create or update the single plan-set implementation PR. Do not merge the PR automatically.

구현 리뷰의 수정이나 사용자 결정 요청 전에 [공통 리뷰 조정](../review-coordination/GUIDE.md)을 적용한다. Spec 변경은 `spec-me`, 영향 계획 수정과 리뷰는 `to-ticket`에 인계하고 승인 결과를 받은 뒤 구현을 재개한다.

## Rules

- Before completion, check current/retired vocabulary and every old entrypoint whose caller moved. Remove consumer-free obsolete wrappers/exports/paths in scope, or report evidenced compatibility and removal conditions. Include UC/BR-to-owner/verification mapping and model-document disposition; passing feature tests alone does not complete a migration.
- The approved removal list must pass the registered `retirement` lifecycle check against the actual workspace before completion. Report its verdict with the ordinary verification evidence. Missing disposition or a remaining approved-for-removal path cannot be treated as completed, even if feature tests or reviewer summaries say passed.

- GitHub mode must not write tracker status to local plan Markdown. local-markdown mode must not call `gh` or update a GitHub Project.
- Plan runtime checkpoint artifacts under `<session_directory>/runtime/plans/` are local-only. Never upload, publish, or copy `checkpoint.md` or `events.jsonl` to GitHub Issues, comments, Project fields, PR bodies, commits, or pushes.
- Do not carry stale context across plans.
- Do not spawn or call a subagent for implementation work. `execution_runner` is allowed only for separate runtime verification and must not edit implementation files.
- This prohibition does not apply to the mandatory read-only `standards_reviewer` and `spec_reviewer` review agents required by step 12.
- Do not call another plan executor from inside implementation.
- Do not widen scope without reporting a blocker.
- GitHub mode에서 테스트·개발 중 새 Issue가 필요하면 `tracker.github.assignees.codex`를 `CODEX_ASSIGNEE`로 해석해 `--assignee "$CODEX_ASSIGNEE"`로 만든다. 기본값은 `@copilot`이다. 기존 Issue의 assignee는 명시적 요청 없이 변경하지 않는다.
- 구현 완료한 split plan은 child Issue를 닫지 않되 Project `Workflow Status`를 `Done`으로 전환한다. `gh-open-pr`는 모든 split plan 완료 후 하나의 plan-set integration PR에만 closing keyword를 넣는다.
- GitHub 완료 상태는 `.codex/harness.yaml`의 `tracker.github.status_field`에 해당하는 Project field에만 기록한다. 기본 Project `Status` field를 대신 갱신하지 않는다.
- GitHub mode status mutation은 `harness-tracker.mjs sync`로 수행한다. 완료 보고 전 `harness-tracker.mjs read --ticket <owner/repo#number>` 결과에서 `status`가 `pass`, `canonical_status`가 `completed`, `issue_state`가 `OPEN`인지 확인한다. 읽기는 exact configured repository와 issue를 조회하므로 보드의 제한 페이지 조회를 직접 조립하지 않는다. 다른 상태나 읽기 실패면 완료 보고·dependent 재계산을 중단한다.

  `ISSUE_NUMBER`와 `REPOSITORY`는 선택한 child Issue에서 확인한다. Project/field 설정은 공통 CLI가 `.codex/harness.yaml`에서 읽는다.

  ```bash
  node .codex/scripts/harness-tracker.mjs read --root "$WORKSPACE_ROOT" --ticket "$REPOSITORY#$ISSUE_NUMBER"
  ```
- Recalculate dependent tickets after their dependency reaches its terminal tracker status, not after the plan-set PR merges.
- Use `Planned`, `In Progress`, `Blocked`, and `Done` in GitHub Project mode; use `planned`, `in-progress`, `blocked`, and `completed` in local-markdown mode.
- If implementation cannot complete because of a blocker, set the selected tracker ticket and matching Beads mirror to their blocked states, then report the blocker.
- When implementing Java code, reuse the project's Lombok convention where configured. Do not add blanket `@Setter` or public construction that bypasses aggregate/value-object invariants; use domain operations and the minimum visibility required by persistence.

PR creation remains a separate `gh-open-pr` step. Do not create or update a PR at an individual split-plan boundary. Once every split plan is fully complete and both reviews are resolved, create or recommend exactly one plan-set integration PR. Do not create a new branch or open a PR before that point, and do not merge the PR automatically.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## Lifecycle 상태와 실행 단계

새 v1 mirror의 시작·차단·완료 전이는 모두 `beads` 스킬의 공통 sync 코드가 canonical을 먼저 갱신하고 Beads를 반영한다. 앞 절의 tracker별 설명은 목적 상태를 뜻하며 v1 mirror에 개별 gh/bd 명령을 중복 실행하지 않는다. 테스트 시작은 `--phase test`, 리뷰 시작은 `--phase review`로 기록하되 lifecycle은 `in-progress`를 유지한다. sync 실패는 업무 실패와 구분하고 canonical을 되돌리지 않는다. gate와 독립 리뷰·통합 계약 검증이 통과한 이후에만 completed로 전환한다.

## 소유 worktree 종료

구현 중에는 상위 workflow가 전달한 `workspace_mode`와 `workspace_reference`를 유지하고 선택된 파일의 종료 절차만 적용한다. standalone 또는 별도 소유 workflow에서는 `session-worktree` GUIDE의 분기로 해당 reference 하나만 읽는다. 하위 단계가 실행 방식을 다시 추론하거나 상위 worktree의 소유권을 가져오지 않는다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## 테스트·서비스 실행 전제

일반 단위·회귀 검증은 프로젝트 `docs/agents/EXEC.md`의 명령을 해당 언어의 기본 CLI로 실행한다. `harness-exec`와 `execution.json`은 명시적 사용자 흐름 E2E에만 사용하며, 그 외 profile을 만들거나 runner로 감싸지 않는다. 실제 E2E에서는 실행 인자·필수 환경·설정 검사와 dependency readiness를 확인하고 receipt를 보고한다.

## E2E 실패 재발 방지

E2E 전·후에는 [공통 실패 학습 절차](../../../.agents/skills/e2e-test/references/failure-learning.md)를 적용한다. caller가 runner의 모든 실패를 `tests.e2e_failures`로 checkpoint/완료 state에 반영하고, 기존 실패 이력을 최신 성공 요약에서 제거하지 않는다. 현행 lesson·예방 검사와 실패별 수정/재검증 증거를 fresh-context handoff 및 다음 실행에 전달한다. 현재 필수 테스트의 실패·미실행과 실제 미해결 blocker는 완료를 막는다. 과거 실패의 학습 분류·지침 갱신·예방 조치 검증 상태는 별도 pending으로 인계하며 테스트 결과나 완료 판정을 바꾸지 않는다. runner는 증거 수집만 맡고 caller가 승인 범위 안에서 EXEC/profile·제품/검사 수정과 검증된 lesson 반영을 맡는다.
