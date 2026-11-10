# code-review

`code-review` reviews the diff between `HEAD` and a caller-supplied fixed point with two independent, read-only reviewers:

- Standards: does the implementation satisfy the ticket-scoped Product Spec?
- Spec: does the implementation satisfy the ticket-scoped Architecture Spec?

이 GUIDE는 reviewer가 읽는다. 리뷰를 실행하고 결과로 수정·사용자 질문·Spec 인계를 정하는 호출 쪽은 [호출과 수정 절차](references/repair.md)를 따른다.

## 역할 실행

When `context.role` is `standards_reviewer` or `spec_reviewer`, perform only that axis as the Standards or Spec section below defines and return its findings. Do not dispatch another reviewer, invoke `code-review` recursively, or edit code, tests, plans, Specs or review artifacts. Do not infer semantic correctness from a hash pass.

지적은 세 가지뿐이다: 승인 Spec의 요구 위반, 저장소 기준 위반(DDD 계층 책임은 [ddd-design](../ddd-design/GUIDE.md)과 [model-continuity](../ddd-design/references/model-continuity.md)가 기준이다), Spec·기준에 근거 없는 추가. 그 밖의 구조 제안이나 더 나은 설계 의견은 지적하지 않는다. 기준 위반은 수정 대상이며 `basis.source: repository_standard`와 해당 기준 문서 경로·원문을 쓴다. 기준이 금지한 과잉 구조(한 구현뿐인 불필요한 port, pass-through service, 같은 입력을 전달하는 wrapper, 사용되지 않는 repository·event)도 같은 방식으로 제거를 지적한다.

Read the code, configuration and execution profiles under review at the given implementation commit with `git show <SHA>:<path>` and the diff; if workspace content differs from that commit, report it instead of mixing it into the evidence.

추가로 발견한 상위 요구의 누락은 해당 요구의 plan owner를 확인해 기록한다. 다른 plan의 미구현 동작은 그 owner로 연결하고, 현재 plan의 인계 계약 위반은 현재 지적으로 보고한다.

## Standards

Standards checks whether the implementation satisfies the ticket-scoped Product Spec and the repository standards: `.codex/repository-conventions.md` (or [default-rules.md](references/default-rules.md) when it is absent), user-managed `docs/architecture/constraints.md` when present, Repository Architecture Policy, related ADR, naming, structure and code smell.
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

Read the plan's [execution evidence contract](../to-ticket/references/execution-evidence.md). Check requirement-to-code-to-verification coverage, baseline/current commits, relevant measurement comparability, and that durable model/diagram/verification-map changes reflect actual code rather than only the target Spec. Missing proof is unverified, not passed; but report `verification_gap` only for a check the plan's own environment can run (its unit tests, build and native CLI). A check that needs real infrastructure (database, external service, security chain) belongs to the final `e2e` plan: do not report it on a feature plan, and do not ask the implementer to add integration tests for it; unrelated performance checks are not required. Standards owns observable acceptance; Spec owns domain/architecture fidelity.

For implement-wrapper reviews, missing or stale Product/Architecture Specs block completion; do not skip either axis. For standalone reviews without a spec artifact, the Spec axis skips and reports that no spec is available.

## Spec 밖 동작

두 축 모두 누락·오동작뿐 아니라 diff가 승인 근거 없이 더한 동작을 찾는다. plan 수용 기준과 테스트를 통과해도 Spec에 근거가 없으면 승인된 것이 아니다. 구현자가 신고한 `review_input.unplanned_additions`도 대조한다.

- 승인 근거 없는 제품 동작은 `unrequested_behavior`로 보고하고 `summary`·`evidence`와 사용자가 판단할 `benefit`·`cost`, 비전문가가 결정할 수 있는 한 문장 `plain_explanation`, `rule_impact`를 쓴다. `rule_impact`는 업무 규칙·제한·검증·상태·데이터 동작을 더하지 않을 때만 `none`이고 그 외에는 `business_rule`이다. 신고된 `rule_impact`가 축소됐으면 별도 지적으로 보고한다.
- 지적 하나에 동작 하나만 담는다. 이미 `unplanned_additions`에 있는 항목이나 `product-decisions.md`에서 사용자가 거절한 항목은 다시 보고하지 않는다. 실행 안내(`EXEC.md`)·테스트 fixture 같은 비제품 파일은 대상이 아니다.
- 수정 지적은 의도에 대해 판정한다. `intent_ref`(INT-*, BR-*, BASELINE-*)와 `failure_scenario`(누가, 어떤 일반적인 행동으로, 어떤 피해를 보는지)를 쓴다. 쓰지 못하면 결함이 아니라 advisory다. 일반 사용자가 겪지 않는 드문 경계 사례도 advisory다. 공통 기본선은 [baseline.md](references/baseline.md)이며 의도에 없어도 항상 결함이다.
- 지적이 요구하는 수정은 승인 문서가 그 수정 자체를 요구해야 한다. 같은 주제의 문장을 인용하는 것으로는 부족하다. 충분한 수준보다 높은 수준을 요구하지 않고, 기록이 없으면 가장 단순한 플랫폼 기본 동작을 기준으로 한다.
- [Product Spec의 범위 기준](../product-spec/GUIDE.md)을 리뷰가 제안하는 새 작업에도 적용한다. 명시 요구 또는 그 작업 없이는 실패하는 UC/BR/AC·공통 기본선을 설명하지 못하는 선택적 기능 제안을 필수 수정이나 사용자 질문으로 만들지 않는다. 넓은 INT 참조와 관행·편의·미래 확장만으로 OAuth·복구 흐름·새 인프라 같은 기능을 요구하지 않는다. 이미 구현된 Spec 밖 동작은 위 신고·사용자 결정 계약을 따른다.
- 두 구현이 어긋나고 그중 하나가 승인되지 않은 동작이면 그 동작을 지적한다. 일관성을 맞추려고 다른 층으로 확대하지 않는다. 수정은 확대가 아니라 제거다.

## 전수 보고와 심각도

한 라운드에 발견할 수 있는 지적을 모두 보고한다. 첫 지적에서 멈추거나 다음 라운드로 미루지 않는다. 라운드마다 하나씩 나오면 수정과 재리뷰가 반복된다.

- **Spec 축:** 먼저 `node .codex/scripts/harness-code-review.mjs spec-items`를 실행해 Architecture Spec의 계약 항목 목록(경로·메서드, schema·migration, 인프라 의존성, 파일·모듈 구조, 인증·인가, 입력 검증, E2E 환경)을 받는다. 항목마다 변경 코드와 대조하고 `report.checked`에 항목 하나당 `{"id":"S6.5-3","verdict":"match|mismatch|not_applicable","evidence":"파일:행 또는 해당 없는 이유"}`를 모두 적는다. 이 plan이 맡지 않은 항목은 `not_applicable`과 담당 plan을 증거로 적는다. `mismatch`인 항목은 반드시 finding을 만들고 그 finding의 `spec_items`에 항목 ID를 적는다. 한 항목이라도 빠지면 결과가 거부되고 리뷰를 다시 해야 한다.
- **Standards 축:** 변경된 파일마다 저장소 기준과 Product Spec 요구를 대조해 위반을 모두 보고한다.
- **심각도:** `blocker`는 동작하지 않거나 데이터·보안 사고를 낸다. `major`는 승인 Spec·plan·계약을 어기거나 요구한 동작이 빠졌다. 하나라도 있으면 `state`가 `failed`다. `minor`만 있으면 `passed`로 두고 finding에 `severity: minor`로 남긴다. `minor`는 이름·표현·사소한 구조처럼 승인된 동작을 바꾸지 않는 개선이다. minor는 수정 라운드를 열지 않고 결과에 기록만 한다. 심각도를 낮춰 지적을 숨기지 않는다.

## 결과 형식

reviewer는 다음 JSON 필드를 반환한다. `state`는 현재 plan을 막는 지적이 있으면 failed, 없으면 passed다. 각 finding은 `id`, `kind`, `severity`(blocker/major/minor), `summary`, `evidence`(파일:행·요구 ID)를 가진다. `kind`는 implementation_defect, test_defect, verification_gap, in_scope_spec_mismatch, requirement_ambiguity, architecture_decision, scope_expansion, spec_conflict, contract_sync, advisory 중 하나다. in_scope_spec_mismatch에는 in_scope:true와 범위 근거를 포함한다. 권고는 kind:advisory로 기록한다. severity는 minor이고 blocking을 true로 쓰지 않는다. 수정 대상 kind(implementation_defect, test_defect, in_scope_spec_mismatch, verification_gap)는 `basis: {source, quote}`가 필수다. `source`는 product_spec, architecture_spec, canonical_plan, repository_standard이며 repository_standard는 `path`도 쓴다. 저장소 표준의 `path`는 `.codex/repository-conventions.md`, 기본 리뷰·테스트 규칙, `.codex/internal-skills/ddd-design/` 아래 DDD 기준, `docs/agents/`, `docs/architecture/`, `docs/contracts/` 아래만 허용한다. `intent_ref`는 Product Spec의 INT·BR ID나 BASELINE ID만 쓴다(UC·AC·지적 ID는 쓰지 않는다). `quote`는 해당 문서의 원문이어야 하며 runtime이 대조한다. 수정 대상 kind는 `intent_ref`와 `failure_scenario`도 필수이며 runtime이 ID의 존재를 대조한다.

## 계약 판정

각 plan은 현행 계약을 기준으로 검토한다. 개별 plan의 contract snapshot 동기화는 kind:contract_sync·severity:minor·disposition:integration_deferred·completion_kind:feature_implemented로 최종 통합에 연결한다. 계약 구조 오류·누락, 실제 구현 결함과 현재 plan의 실행 증거 부족은 해당 blocking kind로 보고한다. 최종 통합 리뷰는 전체 계약·source·검증 증거의 일치와 실제 계약 검사 pass를 확인한다. 현행 `docs/contracts/` 전체와 대조한다. 단 `sync-contracts`가 아직 계약을 작성·seal하지 않아 `harness-contracts.mjs check`가 `contracts_invalid`이고 `docs/contracts/manifest.json`이 비어 있는 상태는 코드·Spec 결함이 아니다. 이때는 blocking finding이 아니라 kind:contract_sync·severity:minor·disposition:integration_deferred·completion_kind:feature_implemented로 보고한다. 계약이 이미 seal된 뒤의 불일치만 blocking으로 보고한다.
