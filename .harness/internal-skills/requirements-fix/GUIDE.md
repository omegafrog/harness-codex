---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# requirements-fix

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## Purpose

Step of the requirements flow after `subdomain-classification` and before `bounded-context`. Fill what the earlier stages left open in `requirements.md` and pass the coverage gate. The document stays `draft`.

`bounded-context`가 컨텍스트 표를 작성하고 `fixed`로 확정한 뒤, orchestrator가 전술 설계에 앞서 사용자 승인을 받는다. 확정된 문서는 사용자의 명시적 수정 지시로만 바꾼다.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- `docs/specs/<plan-set-id>/requirements.md` and `stakeholder-analysis.md`.
- The repository-root `<workspace_root>/CONTEXT.md` (not under `docs/specs/`) for the settled terms.
- The [requirements.md template](references/template.md), which owns the final shape, and the [coverage checklist](references/coverage.md), including its exact writer-facing validation rules for `INV`, `EX`, and `AC` entries.
- 현행 동작이나 기존 결정과의 충돌을 확인해야 할 때 관련 `docs/contracts/` 계약과 연결 다이어그램을 읽는다.

## Prohibited

- Inspecting source or test code, or inferring requirements from the current implementation.
- Asking again about an item already settled by the request, an adopted `CAND`, a recorded user answer in section 7, or a hotspot already `해결`.
- 사용자가 명시했거나 합의된 완료 조건을 안전하게 충족하는 데 꼭 필요한 동작·정책·구성 요소·인프라·검증만 포함한다. 파생 항목에는 어떤 `BIZ`·`INV`·`EX`·`AC`를 충족하는 데 필요한지 적는다. 기존 보안·권한·데이터 보호·오류 처리를 지킨다. 선택적 개선은 질문이나 요구사항에 넣지 않는다.
- 수치와 제한은 사용자 표현 그대로 적는다. 단위·인코딩·정규화·정밀도를 임의로 덧붙이지 않는다.
- 범위·규칙은 사용자 수정 지시 또는 상위 소유 stage의 변경 근거에 따라 보완한다. 확정한 경계나 분류에 문제가 있으면 해당 소유 stage에 돌려보낸다. 이 단계는 `### 1.1`, `CONTEXT.md`, `CONTEXT-MAP.md`, `상태: fixed`와 승인 질문을 소유하지 않는다.

## Process

1. Work in the active workspace. Return `blocked` when `context.workspace.preflight.valid` is false; take document paths from `context.workspace.documents`. Read the repository-root `CONTEXT.md` directly.
2. A `판정: 생략` in `stakeholder-analysis.md` ends this stage at once: write nothing, put the skip and its evidence path in the result summary, and return `completed/OK`.
3. `context.user_revision`, `context.reopen` 또는 `context.revalidation_mark`가 있으면 이전 산출물과 지금의 근거를 대조한다. 사용자 수정은 영향받는 ID의 `## 7. 출처 기록`에 `사용자 수정 지시`와 원문을 기록한다. `출처·변경 이력`에는 stage만 남긴다. 나머지 유효한 결정·ID를 보존하고 영향받는 행만 수정한다. 문서를 `draft`로 두고 컨텍스트의 업무·규칙 소유권이 바뀌는지 요약에 적는다.
4. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 9 when answers exist.
5. [coverage 체크리스트](references/coverage.md)의 각 행을 확인한다. 요청·채택 후보·답변·해결된 hotspot의 결정을 근거와 함께 유지한다. 새로 발견한 독립 업무나 누락된 확정 범위는 `subdomain-candidates`, 경계의 근거 또는 승인이 빠진 경우는 `subdomain-classification`을 가장 앞선 소유자로 지정해 `blocked` / `DEPENDENCY_INCOMPLETE`와 `result.dependency_gap`을 반환한다.
6. `stakeholder-analysis.md`에 `미확정 사실` 표가 있으면 `미정` 행을 이 질문 묶음에 함께 넣고(없으면 이 항목은 건너뛴다), 답을 받으면 그 표의 처리·근거를 `확정`과 `<execution-id>:<n>`으로 고쳐 쓴다. `확정` 행은 영향받는 BIZ의 INV·EX·AC 또는 업무 주체 항목 하나가 OPEN ID를 인용하도록 `requirements.md`에 반영한다. 그 결정의 출처는 `## 7. 출처 기록`에 OPEN ID와 question ID로 한 번 기록한다. 실행기는 `미정` 행과 `이용 조건` `확정` 행의 미반영을 완료 때 거절한다.
7. Independent gap review after the draft is otherwise complete and before any question is returned. First write a provisional `6.5` (template: BIZ | 축 | 대상 | 판정 | 근거): `입력·출처` and `실패` once per 대상 (each input the BIZ depends on, both covering the same set), the other axes once with 대상 `전체`. 판정 is `확정`, `기본값` or `해당 없음`; a row you cannot settle yet is `미정` (refused at completion). On resume, an earlier review can be reused only if its `rows` has exactly one entry for every current non-`미정` 6.5 row and no extras, matched by `(BIZ, 축, 대상)`. If an answer changes a row from `미정` to a settled judgment, or otherwise changes the 6.5 keys, rerun the review so the final rows are independently judged. Do not rerun merely to seek more findings. Start one fresh native `requirements_gap_reviewer` with the model and effort of `context.workspace.gap_reviewer_binding` (Codex: `spawn_agent` with `fork_turns: "none"`; Claude Code: `Agent` with `subagent_type: requirements_gap_reviewer`, foreground); only when the binding is absent run `node .harness/scripts/harness-stage-runtime.mjs binding --root <workspace_root> --skill requirements-gap-review`, and if that fails return `blocked` / `MODEL_BINDING_UNAVAILABLE`. Its prompt is the user request verbatim, the full text of the `BIZ` and common sections as they stand, including provisional `6.5`, and the `## 7` source rows for IDs referenced by that text; no other content. Preserve every sentence verbatim; no reasoning, paraphrase, or codebase. Its answer is `{"rows":[{biz, target, axis, answered, impact, why}],"gaps":[{biz, impact, gap, why_it_changes_the_result, quote}],"missing_inputs":[{biz, target, impact, why}]}`. Apply the [asking criterion](../grilling/GUIDE.md#decide-whether-to-ask) to each finding: a `high` row with `answered: false`, gap or missing input is asked in step 8 and settled afterwards only by an id whose source record cites a recorded question id `<execution-id>:<n>` of this chain (or `사용자 수정 지시` when this reopen is a user revision) or by `해당 없음` with a business reason; a `low` one becomes a `기본값` decided by you and recorded in section 7 as `요청 해석(에이전트 제안)`. You cannot downgrade a reviewer's `high`. Every gap gets a `GAP-nn` row in `6.6`; a gap an earlier decision already answers is not asked again (`확정` citing that item). The runner reads the hook record (only a run after the latest reopen or revision counts) and refuses completion when it never ran or a finding is unsettled. Do not rerun it to look for more findings.
8. Ask in one batch every `PARTIAL` or `UNRESOLVED` BIZ row, every open `6.5` row and every `high` finding of step 7 whose answer is not already settled by an existing source. Everything `low` is a `기본값`, never a question. Write the questions in Korean with the consequence of each alternative, a recommended option and its rationale per the criterion, in the [question format](../grilling/GUIDE.md#ask-questions-the-user-can-answer): settled rules and why-now in `context`, what differs per option in `effect`, the same situation played out per option in `example` (illustration only, never recorded). A question needed only under one option names the condition in its title and offers `해당 없음`. Defer only a question whose options need an earlier answer. A `입력·출처` question is a business question (who prepares or supplies the data, fixed in advance or an external service), with no product name unless the user said it. Never use `해당 없음` because the request does not say or the decision is open. Return `action_required` / `USER_DECISION_REQUIRED` when a question exists; otherwise go to step 10.
9. Classify each answer as `ACCEPTED` (clear choice, agreement or delegation), `REJECTED` (refusal while no alternative is fixed), `QUESTION_OR_CHALLENGE` or `ALTERNATIVE_PROPOSAL`. Answer a question or challenge first, then recheck coverage and ask only what is still open. Record a settled answer in the `BIZ` field or common section and add one `## 7` row for its ID with the `question_id`; a delegated decision and every `기본값` carries its decider and rationale.
10. Write what remains: an `AC` for every normal scenario, `INV` and `EX`, and the common sections `6.1`–`6.6`. Do not append source labels to each line. Record the source only for decisions needing traceability in `## 7. 출처 기록`, keyed by the affected ID; source-backed rules and defaults must remain distinguishable there. Every answer or adopted `CAND` that decides behaviour is stated in exactly one `INV` or `EX` citing it (template 작성 규칙). Items only the agent proposes are marked in section 7 as `요청 해석(에이전트 제안)` and pass the scope admission rule. Use only terms of the `## 3` table; a new confusable word gets a row. Every exception entry has a stable `EX-xx` ID, the condition and an observable failure or refusal result; `NOT_APPLICABLE` and "not offered" are no exception (use `없음 — <business reason>`). `6.5` follows the template: every axis per BIZ, `확정` with ids defined in that BIZ, `기본값` with an id recorded as agent-proposed in section 7, `해당 없음` with a business reason; `입력·출처`, `결과` are never `해당 없음` and `입력·출처`, `권한·공개` never `기본값`. `6.6` has one row per gap (영향 high or low as the reviewer judged), or the line `없음 — <reviewer ran, no guess left>`.
11. Verify the answers, once per answer batch, when this chain has user answers: start the same `requirements_gap_reviewer` in `mode: verify` with the request, the `BIZ` and common text with sources kept, and each question with the chosen answer text and effect, nothing else. It returns `{"unsupported":[{id, quote, why}],"conflicts":[{ids, quotes, why}]}`. Text attributed to an answer that the answer does not say becomes a separate `기본값` item sourced `요청 해석(에이전트 제안)` or is removed. Of two statements that cannot both hold, rewrite the agent-proposed one; when both are the user's, ask in a new batch and verify again after that answer. Rerun only when the runner refused. The runner requires the verify run recorded after the latest answer and every finding gone from the document.
12. Before returning, reread the current `requirements.md` and apply every relevant rule in the checklist's `작성기 검증 규칙` to each BIZ. Do not treat an example or a prior result as proof that the current text passes. Run the gate in the checklist's `확정 조건` except its bounded-context row. When it passes, keep `상태: draft`, add the stage to each touched `출처·변경 이력`, and return `completed/OK` with `requirements.md`. When it fails, go back to step 8 for the failing rows; never hand over a document with an open row.

## Completion

- The independent gap review ran, every finding is asked, settled or a `기본값`, and the verify run (when answers exist) is clean.
- Every checklist row except the bounded-context row is `SETTLED` or `NOT_APPLICABLE` with a reason, and the document's `상태` is still `draft`.
- Every `INV` and `EX` has an `AC`, every adopted `CAND` is placed, and nothing from a rejected or held candidate entered.
- No question was asked about an adopted, answered or resolved item, and no approval question was asked.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `bounded-context` decides the contexts from the completed requirements, then fixes the document; later tactical design stages read the `fixed` `requirements.md` as settled user decisions.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 정의와 신규 정의의 충돌·누락을 비교하고, 범위가 달라지는 판단은 기존 사용자 결정 절차를 따른다.

공통 정의 동기화(`domain-sync.json`)는 소유 Context가 정해진 뒤 `bounded-context`가 한다. 이 stage는 proposal을 쓰지 않는다.
