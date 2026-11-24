---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# requirements-fix

실행 배정에 `document_draft_root`가 있으면 문서별 결정·근거·변경 위치와 필요한 양식을 그 아래의 같은 상대 경로에 간결하게 모은다. 완성 문장은 작성 에이전트가 한 묶음으로 작성한다. 아래의 작성·수정 지시는 작성 에이전트에게 넘길 내용 기준으로 사용하고, 결과에는 정본의 상대 경로를 적는다.

## Purpose

Step of the requirements flow after `subdomain-classification` and before `bounded-context`. Fill what the earlier stages left open in `requirements.md` and pass the coverage gate. The document stays `draft`.

`bounded-context`가 컨텍스트 표를 작성하고 `fixed`로 확정한 뒤, orchestrator가 전술 설계에 앞서 사용자 승인을 받는다. 확정된 문서는 사용자의 명시적 수정 지시로만 바꾼다.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- `docs/specs/<plan-set-id>/requirements.md` and `stakeholder-analysis.md`, resolved with `harness-spec-path.mjs`.
- The repository-root `<workspace_root>/CONTEXT.md` (not under `docs/specs/`; do not resolve it with `harness-spec-path.mjs`) for the settled terms.
- The [requirements.md template](references/template.md), which owns the final shape, and the [coverage checklist](references/coverage.md), including its exact writer-facing validation rules for `INV`, `EX`, and `AC` entries.
- 현행 동작이나 기존 결정과의 충돌을 확인해야 할 때 관련 `docs/contracts/` 계약과 연결 다이어그램을 읽는다.

## Prohibited

- Inspecting source or test code, or inferring requirements from the current implementation.
- Asking again about an item whose source is `요청 원문`, `CAND-xx 채택` or `answers.json`, or about a hotspot already `해결`.
- 사용자가 명시했거나 합의된 완료 조건을 안전하게 충족하는 데 꼭 필요한 동작·정책·구성 요소·인프라·검증만 포함한다. 파생 항목에는 어떤 `BIZ`·`INV`·`EX`·`AC`를 충족하는 데 필요한지 적는다. 기존 보안·권한·데이터 보호·오류 처리를 지킨다. 선택적 개선은 질문이나 요구사항에 넣지 않는다.
- 수치와 제한은 사용자 표현 그대로 적는다. 단위·인코딩·정규화·정밀도를 임의로 덧붙이지 않는다.
- 범위·규칙은 사용자 수정 지시 또는 상위 소유 stage의 변경 근거에 따라 보완한다. 확정한 경계나 분류에 문제가 있으면 해당 소유 stage에 돌려보낸다. 이 단계는 `### 1.1`, `CONTEXT.md`, `CONTEXT-MAP.md`, `상태: fixed`와 승인 질문을 소유하지 않는다.

## Process

1. Work in the active workspace. Run `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json` before anything else and return `blocked` with its output when it fails. Locate only the plan-set documents under `docs/specs/<plan-set-id>/` with `node .harness/scripts/harness-spec-path.mjs <workspace_root> <file>`. Read the repository-root `CONTEXT.md` directly; never pass it to `harness-spec-path.mjs`.
2. A `판정: 생략` in `stakeholder-analysis.md` ends this stage at once: write nothing, put the skip and its evidence path in the result summary, and return `completed/OK`.
3. `context.user_revision`, `context.reopen` 또는 `context.revalidation_mark`가 있으면 이전 산출물과 지금의 근거를 대조한다. 사용자 수정은 영향받는 `BIZ`의 `출처·변경 이력`에 원문을 `사용자 수정 지시`로 남긴다. 나머지 유효한 결정·ID를 보존하고 영향받는 행만 수정한다. 문서를 `draft`로 두고 컨텍스트의 업무·규칙 소유권이 바뀌는지 요약에 적는다.
4. On resume, read the previous result, `requirements.md` and the actual answers. Continue at step 7 when answers exist.
5. [coverage 체크리스트](references/coverage.md)의 각 행을 확인한다. 요청·채택 후보·답변·해결된 hotspot의 결정을 근거와 함께 유지한다. 새로 발견한 독립 업무나 누락된 확정 범위는 `subdomain-candidates`, 경계의 근거 또는 승인이 빠진 경우는 `subdomain-classification`을 가장 앞선 소유자로 지정해 `blocked` / `DEPENDENCY_INCOMPLETE`와 `result.dependency_gap`을 반환한다.
6. `PARTIAL` 또는 `UNRESOLVED`인 BIZ 행은 하나도 빠뜨리지 말고, 그중 결과를 바꾸고 기존 근거나 합리적인 기본값으로 정할 수 없는 결정을 한 번에 묻는다. 한국어로 대안마다 달라지는 결과와 범위를 적고 권장안과 근거를 붙인다. [질문 형식](../grilling/GUIDE.md#ask-questions-the-user-can-answer)에 따라 이미 확정된 규칙과 지금 정해야 하는 이유는 `context`에, 대안마다 화면·동작이 달라지는 점은 `effect`에, 같은 상황을 대안마다 적용한 구체적 예시는 `example`에 적는다. 예시는 설명용이며 요구사항으로 기록하지 않는다. 특정 대안에서만 필요한 질문은 제목에 조건을 밝히고 `해당 없음`을 선택지에 넣는다. 선행 답변을 받아야 선택지를 구체화할 수 있는 질문만 미룬다. 질문이 있으면 `action_required` / `USER_DECISION_REQUIRED`로 반환하고, 없으면 8단계로 간다.
7. 답변마다 `ACCEPTED`(명확한 선택·동의·위임), `REJECTED`(대안 미확정 상태에서 거절), `QUESTION_OR_CHALLENGE`(질문·이의), `ALTERNATIVE_PROPOSAL`(확정 전 대안 제안)로 분류한다. 질문·이의·대안의 영향에 답한 뒤 coverage를 다시 확인하고, 필요한 결정이 남은 경우에만 묶어서 묻는다. 확정 답변은 `BIZ` 필드나 공통 섹션에 `answers.json`과 `question_id`를 출처로 적고, 위임받아 정한 내용과 기본값에는 결정 주체와 근거를 적는다.
8. Write what remains: an `AC` for every normal scenario, `INV` and `EX`, and the common sections `6.1`–`6.4`, each item with its source. Items that only the agent proposes carry `요청 해석(에이전트 제안)` and pass the scope admission rule. Use only terms of the `## 3` table; a new confusable word gets a row there. Every exception-field entry, including a `NOT_APPLICABLE` determination, must have a stable `EX-xx` ID, applicable scenario reference where known, and the actual rule, outcome, or observable condition. Use the checklist's exact writer-facing validation format and do not leave `NOT_APPLICABLE` as an unstructured sentence.
9. Before returning, reread the current `requirements.md` and apply every relevant rule in the checklist's `작성기 검증 규칙` to each BIZ. Do not treat an example or a prior result as proof that the current text passes. Run the gate in the checklist's `확정 조건` except its bounded-context row, which `bounded-context` checks. When it passes, keep `상태: draft`, add the stage to each touched `출처·변경 이력`, and return `completed/OK` with `requirements.md`. When it fails, go back to step 6 for the failing rows; never hand over a document with an open row.

## Completion

- Every checklist row except the bounded-context row is `SETTLED` or `NOT_APPLICABLE` with a reason, and the document's `상태` is still `draft`.
- Every `INV` and `EX` has an `AC`, every adopted `CAND` is placed, and nothing from a rejected or held candidate entered.
- No question was asked about an adopted, answered or resolved item, and no approval question was asked.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `bounded-context` decides the contexts from the completed requirements, then fixes the document; later tactical design stages read the `fixed` `requirements.md` as settled user decisions.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 정의와 신규 정의의 충돌·누락을 비교하고, 범위가 달라지는 판단은 기존 사용자 결정 절차를 따른다.

공통 정의 동기화(`domain-sync.json`)는 소유 Context가 정해진 뒤 `bounded-context`가 한다. 이 stage는 proposal을 쓰지 않는다.
