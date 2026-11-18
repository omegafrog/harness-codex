---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# requirements-fix

## Purpose

Step of the requirements flow after `subdomain-classification` and before `bounded-context`. Fill what the earlier stages left open in `requirements.md` with one interview batch and pass the coverage gate, so that `bounded-context` decides the boundaries from complete requirements. The document stays `draft`: `bounded-context`, the last stage, writes the context table and sets `fixed`. There is no approval question, so this stage is the final requirements coverage and user-decision checkpoint; that is why it runs at the high performance tier. After `fixed`, the document changes only on an explicit user revision.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- `docs/specs/<plan-set-id>/requirements.md` and `stakeholder-analysis.md`, resolved with `harness-spec-path.mjs`, and `CONTEXT.md` for the settled terms.
- The [requirements.md template](references/template.md), which owns the final shape, and the [coverage checklist](references/coverage.md).
- The [Product Spec procedure](../product-spec/GUIDE.md) for its scope admission rule and wording preservation, and [grill-with-docs](../grill-with-docs/GUIDE.md) for its batch interview and response classification.

## Prohibited

- Inspecting source or test code, or inferring requirements from the current implementation.
- Asking again about an item whose source is `요청 원문`, `CAND-xx 채택` or `answers.json`, or about a hotspot already `해결`.
- Adding scope: a behavior, policy, component or verification that is not required by the request or by an agreed completion condition. The Product Spec GUIDE's scope admission rule applies unchanged.
- Introducing a unit, encoding, normalization or precision the user did not state. The user's wording of a limit stays as written, as the Product Spec GUIDE requires.
- Editing a `fixed` document without a user revision, reopening the confirmed subdomains, deciding or writing a bounded context (`### 1.1`), writing to `CONTEXT.md` or `CONTEXT-MAP.md`, setting `상태: fixed`, or asking for approval.

## Process

1. Work in the active workspace. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` before anything else and return `blocked` with its output when it fails. Locate each document with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. A `판정: 생략` in `stakeholder-analysis.md` ends this stage at once: write nothing, put the skip and its evidence path in the result summary, and return `completed/OK`.
3. When `requirements.md` is already `fixed` and the input is not a user revision (`context.user_revision`), change nothing and return `completed/OK`. On a user revision, set `상태: draft`, record the user's instruction verbatim in the affected `BIZ`'s `출처·변경 이력` with the source `사용자 수정 지시`, apply it as a settled decision, re-evaluate only the affected rows and run the gate again at step 9. The document stays `draft` until `bounded-context` runs again and fixes it; state in the result summary whether the revision changes what a context owns, so the orchestrator knows the context table has to be re-checked.
4. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 7 when answers exist.
5. Classify every row of the [coverage checklist](references/coverage.md) for every `BIZ` and for the common sections. Rows settled by the request, adopted candidates, earlier answers and resolved hotspots are `SETTLED` and are not asked.
6. Collect every independent gap that is still `PARTIAL` or `UNRESOLVED` and ask them in one batch, in the batch mode of [grill-with-docs](../grill-with-docs/GUIDE.md), following the batching rules of the Product Spec procedure. Write the questions in Korean, state what choosing each option changes, and give each a recommended option and a rationale from the request. Gaps that only matter under an earlier option stay in the same batch with the condition in the title. Admit only what the scope admission rule allows; leave optional improvements out without asking. Return `action_required` / `USER_DECISION_REQUIRED`. With no gap go to step 8.
7. Classify each answer as the grill-with-docs response rules say, and ask a focused follow-up batch only for a choice that stays unresolved. Record settled answers in the `BIZ` fields (`INV`, `EX`, `AC`, scenarios) or the common sections with the source `answers.json` and the `question_id`.
8. Write what remains: an `AC` for every normal scenario, `INV` and `EX`, and the common sections `6.1`–`6.4`, each item with its source. Items that only the agent proposes carry `요청 해석(에이전트 제안)` and pass the scope admission rule. Use only terms of the `## 3` table; a new confusable word gets a row there.
9. Run the gate in the checklist's `확정 조건` except its bounded-context row, which `bounded-context` checks. When it passes, keep `상태: draft`, add the stage to each touched `출처·변경 이력`, and return `completed/OK` with `requirements.md`. When it fails, go back to step 6 for the failing rows; never hand over a document with an open row.

## Completion

- Every checklist row except the bounded-context row is `SETTLED` or `NOT_APPLICABLE` with a reason, and the document's `상태` is still `draft`.
- Every `INV` and `EX` has an `AC`, every adopted `CAND` is placed, and nothing from a rejected or held candidate entered.
- No question was asked about an adopted, answered or resolved item, and no approval question was asked.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `bounded-context` decides the contexts from the completed requirements, then fixes the document; later tactical design stages read the `fixed` `requirements.md` as settled user decisions.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 정의와 신규 정의의 충돌·누락을 비교하고, 범위가 달라지는 판단은 기존 사용자 결정 절차를 따른다.

공통 정의 동기화(`domain-sync.json`)는 소유 Context가 정해진 뒤 `bounded-context`가 한다. 이 stage는 proposal을 쓰지 않는다.
