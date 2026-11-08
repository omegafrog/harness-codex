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

단위 테스트는 [비즈니스 로직 단위 테스트](../../../.codex/internal-skills/testing-guidance/GUIDE.md#비즈니스-로직-단위-테스트)의 요구 ID·규칙 owner·조건·행위·기대 결과와 대조한다. 검토 기준은 업무 규칙의 명세와 관찰 가능한 동작이다.

## Spec

Spec checks the diff against the ticket-scoped Architecture Spec and asks:

- what the spec asked for that is missing or partial
- what the diff added that the spec did not ask for (see [Spec 밖 동작](#spec-밖-동작))
- what looks implemented but appears wrong relative to the spec

For changed domain behavior, read [model-continuity.md](../../../.codex/internal-skills/ddd-design/references/model-continuity.md) and inspect affected source/callers/tests beyond the diff. Trace each changed rule ID through its declared owner to the actual method/function. Check application/infra rule leakage, setter/collection/direct-write bypasses, duplicated policy, unjustified new modules/types/pass-through layers, forbidden cross-context access, and transaction/communication/deployment decisions. Report `file:line`, violated contract and observed path; distinguish source inspection from executable proof. A function-based model is valid when ownership and invariants hold.

Check current scoped canonical/retired vocabulary against new code and current docs; do not treat historical terms as active aliases. For replacements, verify old consumers/exports/configuration/fixtures were migrated and obsolete implementation was removed. Retained compatibility identifiers or paths require real consumer evidence, boundary mapping and a removal condition; historical records and negative tests are not terminology violations. A second implementation with callers still on the old path is incomplete migration, even when the new path's tests pass.

Also check whether settled design changes made an existing glossary definition/name misleading even without a prior retirement entry. Verify the design recorded a justified keep/definition-change/replacement disposition and reconciled the glossary. Flag unresolved meaning back to architecture; do not silently invent or approve new business meaning during review.

Read the plan's [execution evidence contract](../to-ticket/references/execution-evidence.md). Check requirement-to-code-to-verification coverage, baseline/current commits, relevant measurement comparability, and that durable model/diagram/verification-map changes reflect actual code rather than only the target Spec. Missing proof is unverified, not passed; unrelated performance checks are not required. Both reviewers receive the scoped plan and evidence summary; Standards owns observable acceptance, Spec owns domain/architecture fidelity.

For implement-wrapper reviews, missing or stale Product/Architecture Specs block completion; do not skip either axis. For standalone reviews without a spec artifact, the Spec axis skips and reports that no spec is available.

## Spec 밖 동작

두 축 모두 누락·오동작뿐 아니라 diff가 승인 근거 없이 더한 동작을 찾는다. plan 수용 기준과 테스트를 통과해도 Spec에 근거가 없으면 승인된 것이 아니다. 구현자가 신고한 `review_input.unplanned_additions`도 대조한다.

- 승인 근거 없는 제품 동작은 `unrequested_behavior`로 보고하고 `summary`·`evidence`와 사용자가 판단할 `benefit`·`cost`, `rule_impact`를 쓴다. `rule_impact`는 업무 규칙·제한·검증·상태·데이터 동작을 더하지 않을 때만 `none`이고 그 외에는 `business_rule`이다.
- 지적 하나에 동작 하나만 담는다. 이미 `unplanned_additions`에 있는 항목은 다시 보고하지 않는다. 실행 안내(`EXEC.md`)·테스트 fixture 같은 비제품 파일은 대상이 아니다.
- 수정 지적은 의도에 대해 판정한다. `intent_ref`(INT-*, BR-*, BASELINE-*)와 `failure_scenario`(누가, 어떤 일반적인 행동으로, 어떤 피해를 보는지)를 쓴다. 쓰지 못하면 결함이 아니라 advisory다. 일반 사용자가 겪지 않는 드문 경계 사례도 advisory다. 공통 기본선은 [baseline.md](references/baseline.md)이며 의도에 없어도 항상 결함이다.
- 지적이 요구하는 수정은 승인 문서가 그 수정 자체를 요구해야 한다. 같은 주제의 문장을 인용하는 것으로는 부족하다. 충분한 수준보다 높은 수준을 요구하지 않고, 기록이 없으면 가장 단순한 플랫폼 기본 동작을 기준으로 한다.
- 두 구현이 어긋나고 그중 하나가 승인되지 않은 동작이면 그 동작을 지적한다. 일관성을 맞추려고 다른 층으로 확대하지 않는다. 수정은 확대가 아니라 제거다.

## Inputs

- fixed point ref
- diff between `HEAD` and the fixed point
- commit list
- repository standards or architecture policy
- originating spec or issue reference, if available

## Process

When `context.role` is `standards_reviewer` or `spec_reviewer`, perform only that axis using its role profile and return its findings. Do not dispatch another reviewer.

Otherwise the caller coordinates two independent executions:

1. Confirm the fixed point. If the reviewer model binding is missing, return `blocked/MODEL_BINDING_UNAVAILABLE` with the missing keys; do not invoke setup.
2. Dispatch a fresh `standards_reviewer` with the diff, commit list, Product Spec, scoped plan/evidence and standards sources; allow targeted source/test reads to verify acceptance claims.
3. Dispatch a separate fresh `spec_reviewer` with the diff, commit list, Architecture Spec, affected durable model/ADR refs and scoped plan/evidence; allow source/caller/test reads beyond changed lines to verify rule ownership and bypass paths.
   For every planned implementation, give both reviewers the current Product and Architecture Specs and every canonical plan so they compare behavior and constraints directly; a plan set may still omit part of a Spec.
4. Run them in parallel when supported, otherwise as separate subagent executions. Keep both contexts isolated and read-only. Never run a reviewer pass inline in the parent or simulate isolation with two labels; if isolation is unavailable, report that limitation.
5. Wait for both to finish (a running reviewer is pending, not failed). Preserve their actual return files, execution and thread IDs; never invent reviewer IDs.
6. Aggregate without merging, reranking or letting one axis mask the other, then route the next action with the repair decision below. Do not auto-fix, auto-rerun or auto-close issues.

수정이나 사용자 결정 요청 전에 호출한 구현 workflow가 [공통 리뷰 조정](../../../.codex/internal-skills/review-coordination/GUIDE.md)의 구현 리뷰 절차를 적용한다. 두 축의 결과를 모두 받은 뒤 수정표를 정하고, 계획된 구현의 review_input에는 plan-review check가 반환한 plan_set_id와 review_snapshot_sha256을 각각 plan_set_id·planning_snapshot_sha256으로 보존한다. repair 예약과 최종 완료는 같은 planning snapshot을 기준으로 판정한다.

## 판정과 수정 절차

1. 현재 plan의 requirement IDs·canonical plan·실행 증거를 두 reviewer에게 전달한다. 추가로 발견한 상위 요구의 누락은 해당 요구의 plan owner를 확인해 기록한다. 다른 plan의 미구현 동작은 그 owner로 연결하고, 현재 plan의 인계 계약 위반은 현재 지적으로 보고한다.
2. reviewer를 생성하기 전에 plan-review check의 현재 pass 결과와 `canonical_plan` metadata(kind·reference·input_key·hash_algorithm·normalization·sha256)를 확인한다. hash 판정은 `harness-plan-review.mjs check` 결과를 쓰고 raw 파일 SHA와 비교하지 않는다. `canonical_plan.reference` 파일을 읽으며, `input_key`의 `#canonical` 접미사는 가상 snapshot 식별자다.
3. 검토 대상 코드·설정·실행 프로필은 지정된 implementation commit의 `git show <SHA>:<path>`와 diff를 기준으로 읽는다. Spec·plan의 승인 snapshot도 함께 보존하고 검토 중 변경 여부를 확인한다. 변경된 작업공간 내용을 특정 커밋의 구현 증거로 섞으면 입력을 다시 고정한다.
4. reviewer는 아래 JSON 필드를 반환한다. `state`는 현재 plan을 막는 지적이 있으면 failed, 없으면 passed다. 각 finding은 `id`, `kind`, `severity`(blocker/major/minor), `summary`, `evidence`(파일:행·요구 ID)를 가진다. `kind`는 implementation_defect, test_defect, verification_gap, in_scope_spec_mismatch, requirement_ambiguity, architecture_decision, scope_expansion, spec_conflict, contract_sync, advisory 중 하나다. in_scope_spec_mismatch에는 in_scope:true와 범위 근거를 포함한다. unrequested_behavior는 승인 근거 없이 diff에 들어간 동작이다. 권고는 kind:advisory로 기록한다. severity는 minor이고 blocking을 true로 쓰지 않는다. 수정 대상 kind(implementation_defect, test_defect, in_scope_spec_mismatch, verification_gap)는 `basis: {source, quote}`가 필수다. `source`는 product_spec, architecture_spec, canonical_plan, repository_standard이며 repository_standard는 `path`도 쓴다. 저장소 표준의 `path`는 `.codex/repository-conventions.md`, 기본 리뷰·테스트 규칙, `docs/agents/`, `docs/architecture/`, `docs/contracts/` 아래만 허용한다. `quote`는 해당 문서의 원문이어야 하며 runtime이 대조한다. 수정 대상 kind는 `intent_ref`와 `failure_scenario`도 필수이며 runtime이 ID의 존재를 대조한다.
5. 각 plan은 현행 계약을 기준으로 검토한다. 개별 plan의 contract snapshot 동기화는 kind:contract_sync·severity:minor·disposition:integration_deferred·completion_kind:feature_implemented로 최종 통합에 연결한다. 계약 구조 오류·누락, 실제 구현 결함과 현재 plan의 실행 증거 부족은 해당 blocking kind로 보고한다. 최종 통합 리뷰는 전체 계약·source·검증 증거의 일치와 실제 계약 검사 pass를 확인한다. Learning의 자료 사용 승인 절차는 Architecture 선택 토론에서 적용한다.
6. caller는 session JSON의 최상위 `review_input`에 repository, fixed_point, implementation_commit_sha, commit_list, diff_range, diff, product_spec_path, architecture_spec_path와 구현 stage 결과의 `unplanned_additions`를 보존한다. reviewer에게는 4번의 JSON 계약을 그대로 전달하고, 문장으로 된 응답은 JSON으로 다시 받는다. caller가 내용을 옮겨 적어 finding을 만들거나 reviewer 원본 필드를 고치지 않는다. `reviews` 배열은 role이 standards/spec인 두 객체를 포함한다. 각 객체에 실제 도구의 context_id·independent·fresh_context·implementation_commit_sha, 같은 review_input, reviewer의 state와 report.findings를 붙인다. 실제 agent ID와 원본 응답을 대조한다.
7. 수정·설계 인계·사용자 질문을 하기 전에 지적이 있든 없든 `node .codex/scripts/harness-code-review.mjs repair --root <workspace_root> --plan <plan-id> --reviews <session-relative JSON>`을 실행한다. 기본 한도는 1회이며 승인된 설정이 2회이면 `--max-rounds 2`를 사용한다. `repair`는 `review_input.unplanned_additions` 배열이 없으면 차단한다. 근거 없음이나 인용 불일치로 판정된 수정 지적은 `unbacked_requirement`가 되어 `unrequested_behavior`와 함께 사용자 결정으로 간다. 실행 workspace의 `.io/runtime/reviews/implementation-<plan-id>.json`이 횟수·fixed point·지적의 정본이다. 같은 커밋의 중복 예약과 재개를 통한 한도 상향을 차단한다. wrapper runtime도 같은 예약 함수를 사용한다.
8. requirement_ambiguity·architecture_decision·scope_expansion·spec_conflict이면 구현 수정을 보류하고 먼저 9번으로 사용자에게 묻는다. `spec-me`는 사용자가 Spec에 추가하기로 답한 지적만 받는다. 전환할 때는 요구를 키워 쓰지 말고 지적과 사용자 답을 그대로 넘긴다. 새 명령·새 업무 상태·새 규칙·새 경계가 필요한지와 현재 구현 결함을 구분하고, 발견한 경로 전체·필요 결정·기존 fixed point·commit·repair 기록을 checkpoint에 보존한다. 승인된 Spec과 영향 계획의 fresh review 뒤 같은 구현 기준으로 재개한다. 설계 재검토 중 구현 repair를 먼저 예약하지 않는다.
9. `repair`가 `next_action: user-decision`으로 차단하면 수정을 시작하지 않는다. `user_questions`의 각 `question`을 `questions` 배열에 그대로 넣어 `action_required/USER_DECISION_REQUIRED`로 반환하고 질문 본문을 바꾸지 않는다. 답변을 받으면 session JSON 최상위 `scope_decisions`에 `{finding_id, choice, question_id, answers_ref}`를 기록하고 7번을 다시 실행한다. `answers_ref`는 실제 답변이 담긴 session-relative `answers.json`이며 runtime이 답변과 대조한다. 같은 항목을 가리키는 지적은 원본을 고치지 말고 session JSON 최상위 `scope_groups`에 `{id, finding_ids}`로 묶은 뒤 7번을 다시 실행한다. 그러면 질문이 항목별로 하나만 나오고 결정의 `finding_id`에 그룹 `id`를 쓴다. 지원하지 않기로 한 결정은 `product-decisions.md`에 기록해 같은 지적을 다시 묻지 않는다. `choice`는 reject, accept, adopt다. accept는 묶인 항목이 모두 `rule_impact: none`일 때만 제시되며 Spec 변경 없이 유지하고 리뷰 기록에 남는다. 규칙 영향이 있는 항목의 유지는 adopt와 같이 Spec 승인으로 간다. `unrequested_behavior`의 reject는 제거 수정이며 Spec 변경 없이 진행하고 수리 예산이 소진돼도 허용된다. `unbacked_requirement`의 reject는 지적 기각이다. adopt는 `scope_expansion`으로 바뀌어 8번으로 간다. 사용자가 답하기 전에는 유지도 제거도 하지 않는다.
10. 허용된 수정을 마치면 focused verification과 새 commit을 보존하고 두 축을 새 reviewer로 재검토한다. 한도를 소진하면 `repair`가 남은 지적을 `user_questions`로 돌려준다. 한도 소진을 이유로 지적을 Spec이나 plan 수정으로 올리지 않는다. 사용자가 계속 고치기로 답한 경우에만 plan을 갱신한다. 같은 plan에서 사이클이 3번 끝나면 `resolve`가 `repair_cycle_limit`로 멈추고 질문을 돌려주며, 계속하려면 사용자 답을 `--answers-ref`와 `--question-id`로 전달한다. 한도 초기화는 실제 수정 범위/설계 결정 변경, 그에 따른 새 planning snapshot, 독립 계획 리뷰와 dispatch pass가 모두 있을 때만 허용한다. `resolve --root <workspace_root> --plan <plan-id> --reason '<사용자 결정 원문과 위치>'`는 현재 snapshot이 기존 repair 예약의 snapshot과 달라야 통과한다. 일반 진행 지시, 동일 범위에서의 추가 수정 허용, 근거 없는 요청은 reset하지 않는다. handoff checkpoint에는 수정 예약 결과와 원장 경로·기존 fixed point·남은 지적·다음 작업을 보존한다.

## Output

- fixed point와 implementation commit
- 축별 state·구조화 findings·실제 reviewer metadata
- 현재 plan의 미해결 blocker와 최종 통합으로 연결한 항목

## 소유 worktree

상위 workflow가 전달한 worktree를 그대로 쓰고 소유권·종료를 다루지 않는다. 직접 소유한 실행이면 [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md)를 따른다.

## 실행 산출물 경로

실행 중 생기는 로그·임시 파일·스크린샷은 [실행 산출물 경로](../../../.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md)를 따른다.
