---
name: code-review
description: Review the diff between HEAD and a fixed point with independent Standards and Spec subagents.
---

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [ddd-design](../../../.codex/internal-skills/ddd-design/GUIDE.md) · [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md) · [sync-contracts](../../../.codex/internal-skills/sync-contracts/GUIDE.md).

# code-review

## What it does

`code-review` reviews the diff between `HEAD` and a caller-supplied fixed point using two independent, read-only subagents:

- Standards: does the implementation satisfy the ticket-scoped Product Spec?
- Spec: does the implementation satisfy the ticket-scoped Architecture Spec?

The review only makes sense when there is a fixed point and a diff to judge.

## Standards

Standards checks whether the implementation satisfies the ticket-scoped Product Spec, while also considering repository standards:

- Read `.codex/repository-conventions.md` if it exists.
- If that file is absent, read `references/default-rules.md` instead.

Standards also checks the repo’s documented conventions, user-managed `docs/architecture/constraints.md` when present, Repository Architecture Policy, related ADR, naming, structure, and code smell.
If there is no executable code in scope, treat automated-test-based evaluation as not applicable.

## Spec

Spec checks the diff against the ticket-scoped Architecture Spec and asks:

- what the spec asked for that is missing or partial
- what the diff added that the spec did not ask for
- what looks implemented but appears wrong relative to the spec

For changed domain behavior, read [model-continuity.md](../../../.codex/internal-skills/ddd-design/references/model-continuity.md) and inspect affected source/callers/tests beyond the diff. Trace each changed rule ID through its declared owner to the actual method/function. Check application/infra rule leakage, setter/collection/direct-write bypasses, duplicated policy, unjustified new modules/types/pass-through layers, forbidden cross-context access, and transaction/communication/deployment decisions. Report `file:line`, violated contract and observed path; distinguish source inspection from executable proof. A function-based model is valid when ownership and invariants hold.

Check current scoped canonical/retired vocabulary against new code and current docs; do not treat historical terms as active aliases. For replacements, verify old consumers/exports/configuration/fixtures were migrated and obsolete implementation was removed. Retained compatibility identifiers or paths require real consumer evidence, boundary mapping and a removal condition; historical records and negative tests are not terminology violations. A second implementation with callers still on the old path is incomplete migration, even when the new path's tests pass.

Also check whether settled design changes made an existing glossary definition/name misleading even without a prior retirement entry. Verify the design recorded a justified keep/definition-change/replacement disposition and reconciled the glossary. Flag unresolved meaning back to architecture; do not silently invent or approve new business meaning during review.

Read the plan's [execution evidence contract](../to-ticket/references/execution-evidence.md). Check requirement-to-code-to-verification coverage, baseline/current commits, relevant measurement comparability, and that durable model/diagram/verification-map changes reflect actual code rather than only the target Spec. Missing proof is unverified, not passed; unrelated performance checks are not required. Both reviewers receive the scoped plan and evidence summary; Standards owns observable acceptance, Spec owns domain/architecture fidelity.

If there is no spec artifact, the Spec axis skips and reports that no spec is available.

## Inputs

- fixed point ref
- diff between `HEAD` and the fixed point
- commit list
- repository standards or architecture policy
- originating spec or issue reference, if available

## Process

1. Confirm the fixed point first.
2. Read `.codex/harness.yaml`, resolve `agents.implementation_model` (then legacy low/default values), and pass the resolved model ID explicitly to both reviewer spawns. Do not pass a config-key literal or omit the model.
3. If no model resolves, stop and require `setup`; never inherit the parent model. Reviewer reasoning effort remains the fixed `medium` value of the reviewer profiles.
4. Call `multi_agent_v1.spawn_agent` with `agent_type="standards_reviewer"`, `fork_context: false`, and the resolved model ID. Give it the diff, commit list, Product Spec, scoped plan/evidence and standards sources needed for the Standards axis; allow targeted source/test reads to verify acceptance claims.
5. Call `multi_agent_v1.spawn_agent` with `agent_type="spec_reviewer"`, `fork_context: false`, and the resolved model ID. Give it the diff, commit list, Architecture Spec, affected durable model/ADR refs and scoped plan/evidence. Allow targeted source/caller/test reads needed to verify rule ownership and bypass paths; do not limit it to changed lines.
   For every planned implementation, include the current traceability ledger and require the reviewer to compare the complete source rules with requirement coverage and canonical plan bodies. A complete implementation plan may still omit a source rule.
6. Preserve the actual agent/context identifiers returned by the two spawn calls. Never invent reviewer IDs or simulate isolation with two labels inside the parent context.
7. Run the two reviewers in parallel when the harness supports it; otherwise keep them as separate subagent executions. Never perform either reviewer pass inline in the parent as a substitute for spawning the reviewer.
8. Keep the two subagent contexts isolated and read-only.
9. Wait long enough for both review subagents to finish before aggregating.
10. Aggregate the two reports without merging or reranking them.

## Waiting

- Use `wait_agent` with a long timeout, preferably 300000 ms or longer when the tool allows it.
- Do not use several short 30000 ms waits as the normal path.
- Treat `timed_out` as "still running", not as a review failure.
- If a wait times out, report that the review is still pending and continue waiting unless the user asked for a time limit.
- Close completed review subagents after collecting their final messages.

## Rules

- Do not auto-fix.
- Do not auto-rerun.
- Do not auto-close issues.
- Do not merge Standards and Spec into one verdict.
- Do not let one axis mask the other.
- If subagent isolation is unavailable, report that limitation instead of pretending it ran normally.
- Treat a caller-specified supported model as higher priority than `.codex/harness.yaml` and the lightest-model fallback.

## Output

- fixed point
- Standards findings
- Spec findings
- per-axis summary
- unresolved blockers

## 통합 계약 연속성

시작 시 대상 프로젝트의 `docs/contracts/` 현행 계약과 연결 다이어그램을 읽는다. `sync-contracts`에 따라 영향 섹션·용어·다이어그램·버전을 갱신하고, 정상 종료는 공통 완료 명령의 pass receipt로 확인한다. ticket Spec은 변경 근거다.

## 소유 worktree 종료

`session-worktree`의 공통 종료 규칙을 적용한다. top-level workflow 완료·실패·사용자 중단·handoff에서 소유 writer/agent/서버 종료를 확인한 뒤 archive·검증·제거를 finally로 수행한다. 내부 subagent/개별 단계가 공유 session worktree를 지우지 않는다. 구현의 병렬 owned plan worktree만 WorktreeManager가 개별 정리한다. 순차 execution_line은 생성·소유권 등록·삭제하지 않고 후속 구현에서도 같은 경로를 유지한다. 다른 workflow가 실제 생성·소유한 worktree는 해당 소유자만 정리하고 branch/HEAD/recovery_path/return_root를 남긴다. cleanup 실패는 완료 실패이며, branch·백업·비소유 workspace를 삭제하지 않는다.

## 세션 출력

`docs/agents/EXEC.md`의 세션 파일 출력 경계를 따른다. `harness-session-output.mjs --root <workspace_root>`로 절대 `session_directory`를 구하고 모든 agent/tool에 전달한다. 로그·임시 파일·스크린샷·실행 증거는 그 아래에만 저장한다. 각 process의 TMPDIR/TMP/TEMP와 browser output 경로도 지정한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로에 둔다.
