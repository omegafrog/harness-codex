---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# requirements-fix

## Purpose

Last step of the requirements flow, after `bounded-context`.  Fill what the earlier stages left open in `requirements.md` with one interview batch, then fix the document: when the coverage gate passes, set its `상태` to `fixed` automatically. There is no approval question, so this stage is the final requirements coverage and user-decision checkpoint; that is why it runs at the high performance tier. After `fixed`, the document changes only on an explicit user revision.

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
- Editing a `fixed` document without a user revision, reopening the confirmed subdomains or the bounded-context decision, writing to `CONTEXT.md` or `CONTEXT-MAP.md`, or asking for approval of the fixation.

## Process

1. Work in the active workspace. Run `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` before anything else and return `blocked` with its output when it fails. Locate each document with `node .codex/scripts/harness-spec-path.mjs <workspace_root> <file>`.
2. A `판정: 생략` in `stakeholder-analysis.md` ends this stage at once: write nothing, put the skip and its evidence path in the result summary, and return `completed/OK`.
3. When `requirements.md` is already `fixed` and the input is not a user revision (`context.user_revision`), change nothing and return `completed/OK`. On a user revision, set `상태: draft`, record the user's instruction verbatim in the affected `BIZ`'s `출처·변경 이력` with the source `사용자 수정 지시`, apply it as a settled decision, re-evaluate only the affected rows and fix again at step 9.
4. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 7 when answers exist.
5. Classify every row of the [coverage checklist](references/coverage.md) for every `BIZ` and for the common sections. Rows settled by the request, adopted candidates, earlier answers and resolved hotspots are `SETTLED` and are not asked.
6. Collect every independent gap that is still `PARTIAL` or `UNRESOLVED` and ask them in one batch, in the batch mode of [grill-with-docs](../grill-with-docs/GUIDE.md), following the batching rules of the Product Spec procedure. Write the questions in Korean, state what choosing each option changes, and give each a recommended option and a rationale from the request. Gaps that only matter under an earlier option stay in the same batch with the condition in the title. Admit only what the scope admission rule allows; leave optional improvements out without asking. Return `action_required` / `USER_DECISION_REQUIRED`. With no gap go to step 8.
7. Classify each answer as the grill-with-docs response rules say, and ask a focused follow-up batch only for a choice that stays unresolved. Record settled answers in the `BIZ` fields (`INV`, `EX`, `AC`, scenarios) or the common sections with the source `answers.json` and the `question_id`.
8. Write what remains: an `AC` for every normal scenario, `INV` and `EX`, and the common sections `6.1`–`6.4`, each item with its source. Items that only the agent proposes carry `요청 해석(에이전트 제안)` and pass the scope admission rule. Use only terms of the `## 3` table; a new confusable word gets a row there.
9. Run the gate in the checklist's `확정 조건`. When it passes, set the header, every `BIZ` and every `SD` to `상태: fixed`, add the stage to each `출처·변경 이력`, and return `completed/OK` with `requirements.md`. When it fails, go back to step 6 for the failing rows; never fix the document with an open row.

## Completion

- Every checklist row is `SETTLED` or `NOT_APPLICABLE` with a reason, and the document's `상태` is `fixed`.
- Every `INV` and `EX` has an `AC`, every adopted `CAND` is placed, and nothing from a rejected or held candidate entered.
- No question was asked about an adopted, answered or resolved item, and no approval question was asked.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. later tactical design stages read `fixed` `requirements.md` as settled user decisions.
