---
model_tier: implementation
---
# code-review

`code-review` reviews the diff between `HEAD` and a caller-supplied fixed point with two independent, read-only reviewers:

- Standards: does the implementation satisfy the scope and observable outcomes in `docs/specs/<plan-set-id>/requirements.md`?
- Spec: does the implementation satisfy the model and rule-enforcement decisions in `docs/specs/<plan-set-id>/tactical-design.md` and the cited implementation decisions?

이 GUIDE는 reviewer가 읽는다. 리뷰를 실행하고 결과로 수정·사용자 질문·Spec 인계를 정하는 호출 쪽은 [호출과 수정 절차](references/repair.md)를 따른다.

## 역할 실행

When `context.role` is `standards_reviewer` or `spec_reviewer`, perform only that axis as the Standards or Spec section below defines and return its findings. Do not dispatch another reviewer, invoke `code-review` recursively, or edit code, tests, plans, Specs or review artifacts. Do not infer semantic correctness from a hash pass.

현재 plan set에서 정본인 문서는 `requirements.md`와 `tactical-design.md`다. 지적은 세 가지뿐이다: 승인 요구사항·전술 설계 위반, 저장소 기준 위반(DDD 계층 책임은 [model-continuity](../../requirements/bounded-context/references/model-continuity.md)가 기준이다), 요구사항·설계·기준에 근거 없는 추가. 그 밖의 구조 제안이나 더 나은 설계 의견은 지적하지 않는다. 기준 위반은 수정 대상이며 `basis.source: repository_standard`와 해당 기준 문서 경로·원문을 쓴다. 기준이 금지한 과잉 구조(한 구현뿐인 불필요한 port, pass-through service, 같은 입력을 전달하는 wrapper, 사용되지 않는 repository·event)도 같은 방식으로 제거를 지적한다.

Read the code, configuration and execution profiles under review at the given implementation commit with `git show <SHA>:<path>` and the diff; if workspace content differs from that commit, report it instead of mixing it into the evidence.

추가로 발견한 상위 요구의 누락은 해당 요구의 plan owner를 확인해 기록한다. 다른 plan의 미구현 동작은 그 owner로 연결하고, 현재 plan의 인계 계약 위반은 현재 지적으로 보고한다.

## Standards

Standards checks whether the implementation satisfies the selected plan's BIZ, INV, EX, AC and scope decisions in `requirements_path`, the canonical plan and repository standards: `.codex/repository-conventions.md` (or [default-rules.md](references/default-rules.md) when it is absent), user-managed `docs/architecture/constraints.md` when present, Repository Architecture Policy, related ADR, naming, structure and code smell.
If there is no executable code in scope, treat automated-test-based evaluation as not applicable.

단위 테스트는 [비즈니스 로직 단위 테스트](../../operations/testing-guidance/GUIDE.md#비즈니스-로직-단위-테스트)의 요구 ID·규칙 owner·조건·행위·기대 결과와 대조한다. 검토 기준은 업무 규칙의 명세와 관찰 가능한 동작이다.

## Spec

Spec checks the diff against `tactical_design_path`, the selected canonical plan, and cited technology/API/data/UI decisions, and asks:

- what the spec asked for that is missing or partial
- what the diff added that the spec did not ask for (see [Spec 밖 동작](#spec-밖-동작))
- what looks implemented but appears wrong relative to the spec

For changed domain behavior, read [model-continuity.md](../../requirements/bounded-context/references/model-continuity.md) and inspect affected source/callers/tests beyond the diff. Trace each changed rule ID through its declared owner to the actual method/function. Check application/infra rule leakage, setter/collection/direct-write bypasses, duplicated policy, unjustified new modules/types/pass-through layers, forbidden cross-context access, and transaction/communication/deployment decisions. Report `file:line`, violated contract and observed path; distinguish source inspection from executable proof. A function-based model is valid when ownership and invariants hold.

Check current scoped canonical/retired vocabulary against new code and current docs; do not treat historical terms as active aliases. For replacements, verify old consumers/exports/configuration/fixtures were migrated and obsolete implementation was removed. Retained compatibility identifiers or paths require real consumer evidence, boundary mapping and a removal condition; historical records and negative tests are not terminology violations. A second implementation with callers still on the old path is incomplete migration, even when the new path's tests pass.

Also check whether settled design changes made an existing glossary definition/name misleading even without a prior retirement entry. Verify the design recorded a justified keep/definition-change/replacement disposition and reconciled the glossary. Flag unresolved meaning back to architecture; do not silently invent or approve new business meaning during review.

Read the plan's [execution evidence contract](../../planning/to-ticket/references/execution-evidence.md). Check requirement-to-code-to-verification coverage, baseline/current commits, relevant measurement comparability, and that durable model/diagram/verification-map changes reflect actual code rather than only the target Spec. Missing proof is unverified, not passed; but report `verification_gap` only for a check the plan's own environment can run (its unit tests, build and native CLI). A check that needs real infrastructure (database, external service, security chain) belongs to the final `e2e` plan: do not report it on a feature plan, and do not ask the implementer to add integration tests for it; unrelated performance checks are not required. Standards owns observable acceptance; Spec owns domain/architecture fidelity.

For current workflow reviews, missing or stale `requirements.md` or `tactical-design.md` blocks completion; do not skip either axis. For standalone reviews without a design artifact, the Spec axis skips and reports that no spec is available.

실행 진입점·설정·의존성이 변경되면 실제 entrypoint, 설정 로더, Compose·인프라 정의와 CI를 `.harness/agents/execution.json` 및 EXEC.md와 대조한다. 누락된 인프라·필수 옵션·환경 변수, 생성 설정의 검증 누락, 일반 검사를 E2E 전용 harness-exec로 실행하는 경로를 지적한다. 의존성이나 사전 준비가 필요 없다는 판정에는 소스 근거를 남긴다.

## Spec 밖 동작

두 축 모두 누락·오동작뿐 아니라 diff가 승인 근거 없이 더한 동작을 찾는다. plan 수용 기준과 테스트를 통과해도 Spec에 근거가 없으면 승인된 것이 아니다. 구현자가 신고한 `review_input.unplanned_additions`도 대조한다.

- 승인 근거 없는 제품 동작은 `unrequested_behavior`로 보고하고 `summary`·`evidence`와 사용자가 판단할 `benefit`·`cost`, 비전문가가 결정할 수 있는 한 문장 `plain_explanation`, `rule_impact`를 쓴다. `rule_impact`는 업무 규칙·제한·검증·상태·데이터 동작을 더하지 않을 때만 `none`이고 그 외에는 `business_rule`이다. 신고된 `rule_impact`가 축소됐으면 별도 지적으로 보고한다.
- 지적 하나에 동작 하나만 담는다. 이미 `unplanned_additions`에 있는 항목이나 `product-decisions.md`에서 사용자가 거절한 항목은 다시 보고하지 않는다. 실행 안내(`EXEC.md`)·테스트 fixture 같은 비제품 파일은 대상이 아니다.
- 수정 지적은 의도에 대해 판정한다. `intent_ref`는 현재 요구사항의 `BIZ`·`INV`·`EX`·`AC`·`HS` 또는 전술 설계의 `AS`·`CON` ID를 쓴다. 구형 문서의 `INT`·`BR`과 `BASELINE` ID도 호환된다. `failure_scenario`에는 누가 어떤 일반적인 행동을 해 어떤 결과를 겪는지 쓴다. 근거를 연결할 수 없으면 결함이 아니라 advisory다. 일반 사용자가 겪지 않는 드문 경계 사례도 advisory다. 공통 기본선은 [baseline.md](references/baseline.md)이며 의도에 없어도 항상 결함이다.
- 지적이 요구하는 수정은 승인 문서가 그 수정 자체를 요구해야 한다. 같은 주제의 문장을 인용하는 것으로는 부족하다. 충분한 수준보다 높은 수준을 요구하지 않고, 기록이 없으면 가장 단순한 플랫폼 기본 동작을 기준으로 한다.
- 리뷰가 새 작업을 요구하려면 `requirements.md`의 요청 범위·BIZ·INV·EX·AC 또는 공통 기준을 근거로 제시한다. 그 근거가 없는 선택 기능을 필수 수정이나 사용자 질문으로 만들지 않는다. 넓은 요청 표현과 관행·편의·미래 확장만으로 OAuth·복구 흐름·새 인프라 같은 기능을 요구하지 않는다. 이미 구현된 승인 범위 밖 동작은 위 신고·사용자 결정 계약을 따른다.
- 두 구현이 어긋나고 그중 하나가 승인되지 않은 동작이면 그 동작을 지적한다. 일관성을 맞추려고 다른 층으로 확대하지 않는다. 수정은 확대가 아니라 제거다.

## 전수 보고와 심각도

한 라운드에 발견할 수 있는 지적을 모두 보고한다. 첫 지적에서 멈추거나 다음 라운드로 미루지 않는다. 라운드마다 하나씩 나오면 수정과 재리뷰가 반복된다.

- **Spec 축:** 먼저 `node .harness/scripts/harness-code-review.mjs spec-items`를 실행해 `tactical-design.md`의 설계 항목을 받는다. 각 항목을 변경 코드와 대조하고 `report.checked`에 하나씩 `{"id":"TD-0001","verdict":"match|mismatch|not_applicable","evidence":"파일:행 또는 해당 없는 이유"}`로 기록한다. 구형 Architecture Spec을 받으면 `S6.5-3` 형식 ID가 나올 수 있다. 담당 plan 밖 항목은 `not_applicable`과 소유 plan을 증거로 적는다. `mismatch`는 finding의 `spec_items`에 연결한다. 한 항목이라도 빠지면 결과가 거부된다. Claude Code의 `spec_reviewer`는 셸이 없어 `spec-items`를 실행할 수 없다. 이 경우 호출자가 전달한 CLI 결과를 사용한다.
- **Standards 축:** 변경된 파일마다 저장소 기준과 `requirements.md`의 승인 범위를 대조해 위반을 모두 보고한다.
- **심각도:** `blocker`는 동작하지 않거나 데이터·보안 사고를 낸다. `major`는 승인 Spec·plan·계약을 어기거나 요구한 동작이 빠졌다. 하나라도 있으면 `state`가 `failed`다. `minor`만 있으면 `passed`로 두고 finding에 `severity: minor`로 남긴다. `minor`는 이름·표현·사소한 구조처럼 승인된 동작을 바꾸지 않는 개선이다. minor는 수정 라운드를 열지 않고 결과에 기록만 한다. 심각도를 낮춰 지적을 숨기지 않는다.

## 결과 형식

reviewer는 다음 JSON 필드를 반환한다. `state`는 현재 plan을 막는 지적이 있으면 failed, 없으면 passed다. 각 finding은 `id`, `kind`, `severity`(blocker/major/minor), `summary`, `evidence`(파일:행·요구 ID)를 가진다. `kind`는 implementation_defect, test_defect, verification_gap, in_scope_spec_mismatch, requirement_ambiguity, architecture_decision, scope_expansion, spec_conflict, contract_sync, advisory 중 하나다. in_scope_spec_mismatch에는 in_scope:true와 범위 근거를 포함한다. 권고는 kind:advisory로 기록한다. severity는 minor이고 blocking을 true로 쓰지 않는다. 수정 대상 kind(implementation_defect, test_defect, in_scope_spec_mismatch, verification_gap)는 `basis: {source, quote}`가 필수다. `requirements`, `tactical_design`, `canonical_plan`, `repository_standard`를 쓴다. `repository_standard`는 `path`도 쓴다. 저장소 표준의 `path`는 `.codex/repository-conventions.md`, 기본 리뷰·테스트 규칙, `.harness/skills/requirements/bounded-context/` 아래 DDD 기준, `.harness/agents/`, `docs/architecture/`, `docs/contracts/` 아래만 허용한다. `intent_ref`는 `requirements.md`의 ACT/SD/BIZ/SC/INV/EX/AC/HS ID 또는 `tactical-design.md`의 AS/CON ID를 쓴다. `quote`는 지정된 근거 문서의 원문이어야 하며 runtime이 대조한다. 수정 대상 kind는 `intent_ref`와 `failure_scenario`도 필수이며 runtime이 ID의 존재를 대조한다.

## 계약 판정

각 plan은 현행 계약을 기준으로 검토한다. 개별 plan의 contract snapshot 동기화는 kind:contract_sync·severity:minor·disposition:integration_deferred·completion_kind:feature_implemented로 최종 통합에 연결한다. 계약 구조 오류·누락, 실제 구현 결함과 현재 plan의 실행 증거 부족은 해당 blocking kind로 보고한다. 최종 통합 리뷰는 전체 계약·source·검증 증거의 일치와 실제 계약 검사 pass를 확인한다. 현행 `docs/contracts/` 전체와 대조한다. 단 `sync-contracts`가 아직 계약을 작성·seal하지 않아 `harness-contracts.mjs check`가 `contracts_invalid`이고 `docs/contracts/manifest.json`이 비어 있는 상태는 코드·Spec 결함이 아니다. 이때는 blocking finding이 아니라 kind:contract_sync·severity:minor·disposition:integration_deferred·completion_kind:feature_implemented로 보고한다. 계약이 이미 seal된 뒤의 불일치만 blocking으로 보고한다.
