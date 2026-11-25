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
- Asking again about an item whose source is `요청 원문`, `CAND-xx 채택` or `answers.json`, or about a hotspot already `해결`.
- 사용자가 명시했거나 합의된 완료 조건을 안전하게 충족하는 데 꼭 필요한 동작·정책·구성 요소·인프라·검증만 포함한다. 파생 항목에는 어떤 `BIZ`·`INV`·`EX`·`AC`를 충족하는 데 필요한지 적는다. 기존 보안·권한·데이터 보호·오류 처리를 지킨다. 선택적 개선은 질문이나 요구사항에 넣지 않는다.
- 수치와 제한은 사용자 표현 그대로 적는다. 단위·인코딩·정규화·정밀도를 임의로 덧붙이지 않는다.
- 범위·규칙은 사용자 수정 지시 또는 상위 소유 stage의 변경 근거에 따라 보완한다. 확정한 경계나 분류에 문제가 있으면 해당 소유 stage에 돌려보낸다. 이 단계는 `### 1.1`, `CONTEXT.md`, `CONTEXT-MAP.md`, `상태: fixed`와 승인 질문을 소유하지 않는다.

## Process

1. Work in the active workspace. Return `blocked` when `context.workspace.preflight.valid` is false; take document paths from `context.workspace.documents`. Read the repository-root `CONTEXT.md` directly.
2. A `판정: 생략` in `stakeholder-analysis.md` ends this stage at once: write nothing, put the skip and its evidence path in the result summary, and return `completed/OK`.
3. `context.user_revision`, `context.reopen` 또는 `context.revalidation_mark`가 있으면 이전 산출물과 지금의 근거를 대조한다. 사용자 수정은 영향받는 `BIZ`의 `출처·변경 이력`에 원문을 `사용자 수정 지시`로 남긴다. 나머지 유효한 결정·ID를 보존하고 영향받는 행만 수정한다. 문서를 `draft`로 두고 컨텍스트의 업무·규칙 소유권이 바뀌는지 요약에 적는다.
4. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 9 when answers exist.
5. [coverage 체크리스트](references/coverage.md)의 각 행을 확인한다. 요청·채택 후보·답변·해결된 hotspot의 결정을 근거와 함께 유지한다. 새로 발견한 독립 업무나 누락된 확정 범위는 `subdomain-candidates`, 경계의 근거 또는 승인이 빠진 경우는 `subdomain-classification`을 가장 앞선 소유자로 지정해 `blocked` / `DEPENDENCY_INCOMPLETE`와 `result.dependency_gap`을 반환한다.
6. `stakeholder-analysis.md`에 `미확정 사실` 표가 있으면 `미정` 행을 이 질문 묶음에 함께 넣고(없으면 이 항목은 건너뛴다), 답을 받으면 그 표의 처리·근거를 `확정`과 `<execution-id>:<n>`으로 고쳐 쓴다. `확정` 행은 영향받는 BIZ의 INV·EX·AC 또는 업무 주체 항목 하나가 OPEN ID를 인용하도록 `requirements.md`에 반영한다. 앞 단계가 초안 줄의 출처에 이미 인용한 OPEN ID는 지우지 말고 BIZ로 옮겨 유지한다. 실행기는 `미정` 행과 `이용 조건` `확정` 행의 미반영을 완료 때 거절한다.
7. Independent gap review, once per execution attempt chain, after the draft is otherwise complete and before any question is returned. First fill a provisional `6.5` (BIZ | 자료 | 항목 | 판정 | 근거): `데이터 출처` and `불러오기 실패` one row per resource the BIZ's screens need (for example the reservation calendar screen itself and the reservation list), both covering the same resources; the other three items one row per BIZ with 자료 `전체`. A row you cannot settle from user-sourced text is 판정 `미정`; the runner accepts `미정` only before completion. Skip it on a resume with answers unless you added BIZ content beyond those answers. Start one fresh native `requirements_gap_reviewer` with the model and effort of `context.workspace.gap_reviewer_binding` (Codex: `spawn_agent` with `fork_turns: "none"`; Claude Code: `Agent` with `subagent_type: requirements_gap_reviewer`, foreground). Only when the binding is absent run `node .harness/scripts/harness-stage-runtime.mjs binding --root <workspace_root> --skill requirements-gap-review`; if that fails, return `blocked` / `MODEL_BINDING_UNAVAILABLE`. Its prompt is the user request verbatim and the full text of the `BIZ` and common sections of `requirements.md` as they stand including the provisional `6.5` and every cited sentence in full, copied from the document, nothing else: no reasoning of yours, no paraphrase and no codebase (the `출처:` tails may be dropped, a sentence never). Its answer is one JSON object `{"rows":[{biz, resource, item, answered, why}],"gaps":[{biz, gap, why_it_changes_the_result, quote}],"missing_resources":[{biz, resource, why}]}`. A `rows` entry with `answered: false` and every `missing_resources` entry is not settled by your own wording: it becomes a question in the next step (`데이터 출처` as a business question: who prepares the data, fixed in advance or an external service, no product name unless the user said it, with a smallest option), and its row is settled afterwards only by an id whose definition cites that recorded question id (or `사용자 수정 지시`), or by `해당 없음` with a business reason. An id cited from an earlier stage's answers (event-storming and the like) or an invented question id does not settle it; the runner accepts only a question id `<execution-id>:<n>` of this requirements-fix chain whose answer it finds recorded after the review, or a `사용자 수정 지시` when this reopen is a user revision. Every gap gets a `GAP-nn` row in `### 6.6 빈틈 검토` (`GAP | BIZ | 추측해야 하는 것 | 처리 | 근거`). A gap that an item already decided (`answers.json`, an adopted `CAND`, a settled `INV`·`EX`·`AC`) answers is not asked again: its row is `확정` citing that item's id. Every other gap joins the question batch of the next step. The runner reads the hook record of the reviewer's run (only a run after the latest reopen or revision counts) and refuses completion when it never ran, a gap it returned has no row, an unanswered row is unchanged, or a missing resource has no rows. Do not rerun it to look for more.
8. `PARTIAL` 또는 `UNRESOLVED`인 BIZ 행, 판정할 수 없는 `6.5` 행(데이터 출처, 표시 항목, 누락·부분 데이터, 빈 상태, 불러오기 실패)과 7단계의 빈틈은 하나도 빠뜨리지 말고, 그중 결과를 바꾸고 기존 근거나 합리적인 기본값으로 정할 수 없는 결정을 한 번에 묻는다. 한국어로 대안마다 달라지는 결과와 범위를 적고 권장안과 근거를 붙인다. [질문 형식](../grilling/GUIDE.md#ask-questions-the-user-can-answer)에 따라 이미 확정된 규칙과 지금 정해야 하는 이유는 `context`에, 대안마다 화면·동작이 달라지는 점은 `effect`에, 같은 상황을 대안마다 적용한 구체적 예시는 `example`에 적는다. 예시는 설명용이며 요구사항으로 기록하지 않는다. 특정 대안에서만 필요한 질문은 제목에 조건을 밝히고 `해당 없음`을 선택지에 넣는다. 선행 답변을 받아야 선택지를 구체화할 수 있는 질문만 미룬다. `6.5`와 빈틈 질문은 범위를 늘리지 않는다: 고정 데이터·안내 문구 같은 가장 작은 선택지를 넣고, 기술 제품 이름은 사용자가 말한 것만 쓴다. 요청에 없거나 미정이라는 이유로 `해당 없음`을 쓰지 않는다. 질문이 있으면 `action_required` / `USER_DECISION_REQUIRED`로 반환하고, 없으면 10단계로 간다.
9. 답변마다 `ACCEPTED`(명확한 선택·동의·위임), `REJECTED`(대안 미확정 상태에서 거절), `QUESTION_OR_CHALLENGE`(질문·이의), `ALTERNATIVE_PROPOSAL`(확정 전 대안 제안)로 분류한다. 질문·이의·대안의 영향에 답한 뒤 coverage를 다시 확인하고, 필요한 결정이 남은 경우에만 묶어서 묻는다. 확정 답변은 `BIZ` 필드나 공통 섹션에 `answers.json`과 `question_id`를 출처로 적고, 위임받아 정한 내용과 기본값에는 결정 주체와 근거를 적는다.
10. Write what remains: an `AC` for every normal scenario, `INV` and `EX`, and the common sections `6.1`–`6.6`, each item with its source. Items that only the agent proposes carry `요청 해석(에이전트 제안)` and pass the scope admission rule. Use only terms of the `## 3` table; a new confusable word gets a row there. Every exception-field entry has a stable `EX-xx` ID, the condition and an observable failure or refusal result; `NOT_APPLICABLE` and "not offered" are no exception (use `없음 — <business reason>` for a BIZ without one). `6.5` has the columns BIZ | 자료 | 항목 | 판정 | 근거: `데이터 출처` and `불러오기 실패` once per resource (the same resources for both), the other three once per BIZ with 자료 `전체`, each `확정` with ids defined in that BIZ or `해당 없음` with a business reason. `6.6` holds one row per gap the reviewer returned, judged the same way (`확정` cites ids defined in that BIZ), or the one line `없음 — <reviewer ran, no guess left>`.
11. Before returning, reread the current `requirements.md` and apply every relevant rule in the checklist's `작성기 검증 규칙` to each BIZ. Do not treat an example or a prior result as proof that the current text passes. Run the gate in the checklist's `확정 조건` except its bounded-context row, which `bounded-context` checks. When it passes, keep `상태: draft`, add the stage to each touched `출처·변경 이력`, and return `completed/OK` with `requirements.md`. When it fails, go back to step 8 for the failing rows; never hand over a document with an open row.

## Completion

- The independent gap review ran and every gap it returned has a `6.6` row.
- Every checklist row except the bounded-context row is `SETTLED` or `NOT_APPLICABLE` with a reason, and the document's `상태` is still `draft`.
- Every `INV` and `EX` has an `AC`, every adopted `CAND` is placed, and nothing from a rejected or held candidate entered.
- No question was asked about an adopted, answered or resolved item, and no approval question was asked.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `bounded-context` decides the contexts from the completed requirements, then fixes the document; later tactical design stages read the `fixed` `requirements.md` as settled user decisions.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 정의와 신규 정의의 충돌·누락을 비교하고, 범위가 달라지는 판단은 기존 사용자 결정 절차를 따른다.

공통 정의 동기화(`domain-sync.json`)는 소유 Context가 정해진 뒤 `bounded-context`가 한다. 이 stage는 proposal을 쓰지 않는다.
