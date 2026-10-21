---
name: implement-wrapper
description: Schedule approved plans into dependency-safe, single-slot subagent executions with handoff and conflict routing.
---

# implement-wrapper

구현 준비는 tracker 전환·fixed point·worktree 분기·코드 수정·agent dispatch보다 먼저 수행한다. [setup의 준비 복구](../setup/SKILL.md#설치업데이트-및-구현-전-준비-복구)를 읽고, `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --for-implementation --json`의 실제 pass를 확인한다. 누락된 실행/통합 계약은 caller가 source 조사로 준비하고 재검사한다. 단순 파일 누락을 커밋 뒤 외부 blocker로 미루지 않는다.


Use `implement-wrapper` for approved multi-plan tickets. Wrapper schedules and routes; `implement` subagents implement, verify, review, commit, and update status. Model and reasoning selection belong to the caller/runtime; this skill does not force either.

## Schedule

## 작업 루트 전달과 검증

- 활성 세션 worktree를 절대 `execution_line`으로 확정한다. 모든 실행 슬롯은 모드와 관계없이 절대 `workspace_root`와 `cwd`를 받는다. 병렬 계획은 계획별 격리 worktree를 받고, 순차 계획은 `execution_line`을 재사용한다.
- 구현 에이전트와 E2E runner는 파일 접근이나 서비스 시작 전에 `pwd`와 `git rev-parse --show-toplevel`을 전달받은 루트와 대조한다. 구현 결과에 확인한 루트를 포함하고 wrapper가 일치 여부를 검사한다.

- Read `docs/plans/<plan-set-id>/plans.md` when present for split-plan backlinks and summaries. Each plan set has its own directory; never read or write a shared `docs/plans/plans.md`. In GitHub mode, resolve approval, status, dependencies, and shared resources from the linked parent/child Issues and GitHub Project; in local-markdown mode, resolve them from the linked plan documents. If an Issue is absent from the index, reconcile the index only from an existing reviewed traceability ledger and verified parent/child mapping. Project membership or `Planned` status alone does not approve a plan; if the ledger/review or mapping is missing, identify that exact missing evidence and keep dispatch blocked. An API/read failure leaves approval or status unknown and is reported as such, not as proof the Issue is absent.
- Read `.codex/harness.yaml` first. A `Planned` GitHub Project item or `planned` local ticket with no incomplete blockers is a candidate; dependencies wait for completion in the selected tracker.
- Keep model and reasoning selection under caller/runtime policy. Do not infer or force a model tier for plan execution.
- Shared resource conflict or uncertainty means sequential execution; independent plans spawn in parallel.
- Resolve one absolute `execution_line` root for the plan set from the active session worktree. Every plan dispatch must pass an explicit absolute `workspace_root` and `cwd`: parallel plans receive their allocated isolated worktree, while sequential plans receive the same `execution_line` root. Sequential mode does not allocate a new per-plan worktree, but it still receives and verifies its working root.
- Give each plan one execution slot. A slot limits concurrent work; it does not reserve an agent identity or permit an agent to execute another plan. Return `ready_plans`, `waiting_plans`, `parallel_groups`, `single_slot_plan_ids`, and reasons.
- In GitHub mode, when at least one child plan is ready for dispatch, find the Beads parent epic using `harness_plan_id=$PLAN_SET_ID:parent`, set it to `in_progress`, and verify it. After each completion, close the epic only when every Beads child is `closed`. Do not create an epic for local-markdown mode.
- Start every plan ticket with a newly spawned `implement` subagent whose execution context contains no prior plan work. Never reuse a completed, handed-off, or blocked plan's subagent for the next plan.
- Before implementation begins, activate the installed Ponytail plugin's `ponytail` skill in its default `full` mode. The implementation subagent must follow its YAGNI/minimal-change guidance for coding decisions; if the skill is unavailable, stop dispatch and report that the Ponytail plugin must be installed/enabled.
- Before dispatch, assess whether the plan's next bounded implementation action fits inside the Context Smart Zone: enough remaining context to reload the plan/specs/checkpoint, implement or resolve one code blocker, and run its focused verification. If it does not fit, checkpoint and start a fresh subagent for the same plan.
- Before spawning, the wrapper re-reads the plan-set traceability ledger, reviewed source inputs, and canonical plan body. Missing or stale review blocks the actual spawn. Before completion it rechecks requirement-specific source/test hashes and the current successful harness-exec receipt; a checkpoint or prior pass cannot substitute.
- Prompt each subagent with repository, absolute `workspace_root`, absolute `shared_guidance_root` (`return_root`), exact plan path, its `docs/plans/<plan-set-id>/plans.md` backlink, `docs/specs/product-spec.md`, `docs/specs/architecture-spec.md`, both shared guidance documents, `.codex/skills/implement/SKILL.md`, checkpoint, dependency/resource facts, Smart Zone assessment, and exactly one plan/strict scope. Verify both roots share the same Git common directory. The spawn adapter must set `cwd` to `workspace_root`. Require the implementer to report both roots and the verified `git rev-parse --show-toplevel`; reject a mismatch before review or completion. Do not implement checkpoint, conflict, or reconciliation in this slice.
- Every dispatched `implement` subagent owns the complete implementation/review-repair loop. It captures the pre-change `HEAD` once as `review_fixed_point`, commits implementation, then invokes `code-review` and waits for both independent reviewers. `standards_reviewer` evaluates against the ticket-scoped Product Spec; `spec_reviewer` evaluates against the ticket-scoped Architecture Spec. For every blocking finding, the agent must read the exact report and both Specs, make a bounded correction, run focused verification, commit, and rerun both reviews against the same `review_fixed_point` so the cumulative diff is checked. Repeat until no blocking findings remain and both latest reports pass. If a reviewer result is missing, first wait if it is still running, then retry the missing review in a fresh reviewer context against the same commit/fixed point; a repeated reviewer environment failure is an external blocker. Do not complete the plan on a missing or stale review result.
- Parallel worktrees use a dedicated `harness/<run>/<group>/<plan>-<instance>` branch created at the group's fixed base. The implementer must commit there. Removing the temporary worktree preserves that branch; record its name and final implementation commit in the plan checkpoint so cleanup cannot orphan the result.

## Handoff

Pass requirement/rule/target IDs, affected durable model references and the [execution evidence contract](../to-ticket/references/execution-evidence.md) to every plan slot and fresh-context handoff. Preserve `tests.traceability` and `tests.measurements` through the existing checkpoint writer/replay; do not drop prior baseline or failed-attempt evidence when replacing a summary. After integration, recheck shared model/verification-map changes and the plan-set's representative user path/metrics when affected. Per-plan passes alone do not prove integrated behavior. Keep runtime evidence local under the existing publication restrictions.

Use `<session_directory>/runtime/plans/<plan-id>/checkpoint.md`; it is local-only, and does not replace the official plan status. Never upload, publish, or copy `checkpoint.md` or `events.jsonl` to GitHub Issues, comments, Project fields, PR bodies, commits, or pushes. Include the local path in every prompt.

```yaml
plan_id: <plan-id>
orchestration_state: running | handoff-required | conflict-paused | priority-routed
attempt: <integer>
last_completed_step: <text>
changed_files: []
tests: <evidence>
blocker: <kind, summary, unblock_condition>
smart_zone: <dispatch | before-next-action | after-action; fits | handoff-required; evidence>
next_action: <text>
handoff_reason: context-threshold | plan-boundary | milestone | retry
updated_at: <timestamp>
```

Before a subagent starts, assess the Context Smart Zone. After every material action, assess the Context Smart Zone again, including after a test failure, code-blocker attempt, milestone, and completion. If the next action would cross the zone, write a checkpoint with `handoff_reason: context-threshold`, stop that agent, and start a new empty-context subagent for the same `in-progress` plan. A handoff resumes the same plan only through that new subagent; the single plan slot resumes as `in-progress`. Read checkpoint, plan, specs, and Git/test state. Actual state is the source of truth; correct the checkpoint.

At every plan boundary, checkpoint the completed plan and dispatch the next eligible plan only to a new empty-context subagent, even when the previous agent has remaining context. Record `handoff_reason: plan-boundary`; a plan boundary is never a reason to continue with the previous agent.

## Conflict / blocker

- Record conflict evidence and affected plan ids in each related plan's checkpoint; stops the related execution slots as `conflict-paused`.
- Parallel branches are not merged while their workers are running. Conflict-paused plans cannot resume before the main session makes an explicit priority decision; it selects exactly one affected plan to resume first and remaining plans are re-evaluated.
- Report blocker kind, summary, and exact unblock condition. The implementing subagent owns code blocker resolution inside the Context Smart Zone: diagnose, make the bounded fix, and run focused verification in the active plan slot. A code blocker that would exceed the zone is checkpointed and handed to a new empty-context subagent for the same plan; it is not made official `blocked` merely for a context limit. An external environment, authority, dependency, or decision blocker is official `blocked`.
- Review findings follow this same recovery rule. On Smart Zone handoff, checkpoint the original `review_fixed_point`, latest commit, both latest review reports, each unresolved finding, ticket-scoped Product/Architecture Spec paths, verification evidence, and next bounded repair. The fresh agent reads that evidence, fixes the code finding, commits, verifies, and reruns both reviewers against the same fixed point. External environment, permission, dependency, or decision blockers set the selected ticket to its tracker `Blocked` state and stop the repair loop until the stated unblock condition is met.
- If blocker resolution requires a new architecture decision, cross-plan reconciliation, or complex root-cause analysis, escalate the fresh recovery subagent according to caller/runtime policy; ordinary retries remain in the normal execution lane.
- Read the [shared verification policy](../e2e-test/references/verification-policy.md) and dispatch E2E only for explicit E2E/full-stack/browser end-to-end requests or approved critical cross-boundary risks that cheaper checks cannot establish. A UI change alone is insufficient. When required, pass the approved scenario, observable oracle, profile, timeout, and remaining shared attempt budget. The runner owns process startup, evidence, bounded polling and cleanup; it must not edit source or tests. Require its startup root check before services launch.

Canonical ticket statuses are `Planned`, `In Progress`, `Blocked`, `Done` in GitHub Project mode and `planned`, `in-progress`, `blocked`, `completed` in local-markdown mode. Keep `conflict-paused` and `priority-routed` as orchestration states, never tracker status.

A Spec being dirty or uncommitted relative to Git HEAD does not by itself make its review stale. Keep ticket existence, canonical tracker status, and planning-review approval as separate facts; a failed status read or dirty tree does not prove a ticket or approved plan is absent. Dispatch must run the traceability/spec-review current-input check against the bytes actually present in the workspace; report the exact ledger, review, or source input the gate says is missing or stale. Apply workspace cleanliness or integration rules separately and report their exact evidence; do not bypass a missing approval.

## Completion

For new dispatches, resolve the approved plan's removal disposition into the `retirement` runtime option: `{ removed_paths: ["relative/old-path"], reason: "..." }`. Never substitute the implementer's proposed list or silently drop approved removals. `executeImplementPlan` checks actual paths in its verified workspace before completion; the workflow `before_complete` hook also requires `retirement: { workspace_root, removed_paths, reason }`. Keep this evidence with completion. No replacements means an empty list with the reason, not a fabricated old path. Legacy direct API callers without this option retain their existing behavior; do not claim retirement coverage for those calls.

Delegate completion to `implement`; unresolved review or unresolved blocker must not become `completed`. The wrapper must not edit implementation code or change the official plan status. The completion handoff must include both Standards and Spec reports separately. On completed plan status, re-evaluate selected-tracker dependents. After each split plan's implementation, verification, commit, and both reviews are fully complete and resolved, `implement` moves that plan to `Done` (`completed` in local-markdown mode). After every split plan is terminal and verified, integrate each preserved parallel plan branch into the explicit `execution_line` plan-set branch, one at a time, with `WorktreeManager.integrate`; pass the expected session branch and keep the integration order in the checkpoint. The integration helper checks the target branch, clean state, and shared fixed base, and aborts a conflicted merge while retaining all plan branches. Resolve any conflict in the plan-set branch and re-run the integration gate before proceeding. Only after integration succeeds, invoke or recommend `gh-open-pr` exactly once for that plan-set branch; never create or update a PR at an individual split-plan boundary. Do not merge the PR automatically.

After a split plan completes, keep its child Issue open but set its configured `Workflow Status` Project field to `Done` with `gh project item-edit`; do not update the default Project `Status` field as a substitute. Verify the configured field is `Done` and the child Issue remains open before reporting completion. This status does not wait for the integration PR merge. Recalculate selected-tracker dependents from completed split plans. After the one plan-set integration PR merges, verify intended Issue closure only; do not roll completed split plans back to `In Progress`. Mirror each selected-tracker lifecycle transition to the matching Beads issue by exact `external_ref`; in GitHub mode also move the parent epic to `in_progress` while children execute and close it after all children close. The configured tracker remains authoritative. Do not copy status to another configured tracker or use triage labels for execution state. Report at least one executable ticket or that the entire graph is blocked.

Do not auto-merge or auto-prioritize. When an applicable, planned `ui ~ entity` E2E cannot run because its runtime is missing, record an environment blocker with the exact provisioning condition. An approved `해당 없음` disposition for an unaffected surface does not require creating a UI/server just for verification. Contract tests are executable verification of their own contract, not a substitute for an applicable blocked user journey.

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 새 tracker mirror의 공통 전이

`beads` 스킬의 v1 상태 계약을 따른다. 신규 ticket은 공통 `harness-tracker.mjs sync`가 canonical 갱신·재조회·Beads 반영·재조회를 담당한다. parent epic도 같은 ref별 명령을 사용한다. `backlog`는 분류, `test/review`는 단계 metadata이며 tracker 상태로 쓰지 않는다. dispatch/완료가 `tracker_sync`를 실제 확인하므로 실패 시 agent 생성·정상 완료·종속 plan 진행을 차단하고 sync만 재시도한다. 기존 데이터는 migration하지 않는다.

## 소유 worktree 종료

`session-worktree`의 공통 종료 규칙을 적용한다. top-level workflow 완료·실패·사용자 중단·handoff에서 소유 writer/agent/서버 종료를 확인한 뒤 archive·검증·제거를 finally로 수행한다. 내부 subagent/개별 단계가 공유 session worktree를 지우지 않는다. 구현의 owned plan worktree는 WorktreeManager가 개별 정리하고, sequential execution_line은 상위 workflow 종료 시 정리한다. branch/HEAD/recovery_path/return_root를 남기고 downstream은 보존한 branch로 새 경로를 만든다. cleanup 실패는 완료 실패이며, branch·백업·비소유 workspace를 삭제하지 않는다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.

## 테스트·서비스 실행 전제

테스트·서버·인프라 명령은 `docs/agents/EXEC.md`와 해당 프로젝트의 `docs/agents/execution.json`을 먼저 대조한 뒤 `node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile <id>`로만 실행한다. 필수 인자·환경값·설정 prepare/verify·인프라와 선행 서버 readiness가 실제 entrypoint와 일치해야 한다. 프로필 누락/실패 시 직접 명령으로 우회하지 않는다. caller가 프로필을 보완하고 runner는 설정을 추정·수정하지 않는다. 설정/의존성/시작 인자가 바뀐 구현은 프로필·EXEC도 함께 갱신한다. 결과에는 실행 profile·receipt·실제 준비/검증 실패를 포함한다.

## E2E 실패 재발 방지

E2E 전·후에는 [공통 실패 학습 절차](../e2e-test/references/failure-learning.md)를 적용한다. caller가 runner의 모든 실패를 `tests.e2e_failures`로 checkpoint/완료 state에 반영하고, 기존 실패 이력을 최신 성공 요약에서 제거하지 않는다. 현행 lesson·예방 검사와 실패별 수정/재검증 증거를 fresh-context handoff 및 다음 실행에 전달한다. 미해결 원인·외부 blocker·검증되지 않은 예방 조치는 완료를 막는다. runner는 증거 수집만 맡고 caller가 승인 범위 안에서 EXEC/profile·제품/검사 수정과 검증된 lesson 반영을 맡는다.
