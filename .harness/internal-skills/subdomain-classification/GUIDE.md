---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# subdomain-classification

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## Purpose

Step of the requirements flow after `event-storming` and before `requirements-fix`. Check the boundaries of the subdomain candidates against the event flows, classify each subdomain as core, supporting or generic with a rationale, and settle the set and the classification: ask only where competing groupings remain plausible and differ in business responsibility, otherwise record them as the agent's interpretation for the requirements approval. This is where the candidates stop being hypotheses. No persona runs. Only the business grouping is judged here; bounded contexts, modules and technology are not.

## Inputs

- The user request (`scope` of the execution input), read verbatim.
- Earlier stages' results and answers: the `context.upstream` refs of the input. Read them; never search `.io` for them.
- `docs/specs/<plan-set-id>/requirements.md` with its SD table, `BIZ` sections, event flow tables, `## 4` cross-subdomain events and hotspot decisions, and `stakeholder-analysis.md`.
- `CONTEXT-MAP.md` and `docs/architecture/domain-model.md`, read-only and only when present, for a classification an existing area already carries.
- The [requirements.md template](../requirements-fix/references/template.md), which owns the SD table columns, and the [event diagram reference](../event-storming/references/diagrams.md) for the diagrams a changed set needs.

## Prohibited

- Inspecting source or test code, or naming bounded contexts, modules or technology.
- Writing to `CONTEXT.md`, `CONTEXT-MAP.md` or `docs/architecture/`.
- Changing a requirement, rule, event or scenario. Moving a `BIZ` to another subdomain keeps its text and its sources.
- Classifying by technical complexity, size or effort. The classes describe the business, not the work.
- Asking again about a classification the user already gave, or presenting a recommendation as the user's decision (an unasked one is sourced `요청 해석(에이전트 제안)`).

## Process

1. Work in the active workspace. Return `blocked` when `context.workspace.preflight.valid` is false; take document paths from `context.workspace.documents`.
2. If `stakeholder-analysis.md` says `판정: 생략`, there is nothing to classify: write no file, record the skip and the evidence path in the summary and return `completed/OK`.
3. 재개할 때 이전 결과와 `requirements.md`, 실제 답변, 수정 지시를 읽는다. 그대로 유효한 분류와 경계 결정을 보존한다. 수정 지시로 영향을 받은 묶음은 근거를 다시 비교한다. 독립적으로 완료할 업무가 다른 `BIZ`의 규칙이나 정책에 묻혀 있다면 분류로 덮지 않고 `blocked` / `DEPENDENCY_INCOMPLETE`를 반환한다. `result.owner_stage`에 `subdomain-candidates`, `result.dependency_gap`에 원래 근거와 빠진 업무를 적는다.
4. 업무 목적, 행위자, 용어의 의미, 규칙의 책임, 이벤트의 발생과 반응을 기준으로 현재 묶음과 실질적으로 가능한 합치기·나누기·이동 대안을 같은 기준에서 비교한다. 각 대안에 포함될 `SD`·`BIZ`, 바뀌는 업무 책임, 유리하거나 불리한 근거를 기록한다. 현재 묶음을 유지하는 안도 근거를 비교한다. 대안이 성립하지 않는 경우 그 근거를 적는다. 범위와 BIZ ID를 보존하고, 분리로 생긴 새 SD에는 새 번호를 배정한다.
5. Classify every subdomain from `requirements.md`, not from general knowledge: `core` is what differentiates this request, `generic` is a commodity business such as authentication that any product needs in the same way, `supporting` is needed but does not differentiate. Write a rationale that names the `BIZ`, actors or events it rests on. Reuse a classification that `CONTEXT-MAP.md` already gives an existing area unless this request changes that area's role.
6. [asking criterion](../grilling/GUIDE.md#decide-whether-to-ask)로 묻는다: 경쟁하는 묶음이 실질적으로 남아 있고 그 묶음들이 업무 책임·범위에서 서로 다를 때만 한 묶음의 한국어 `[서브도메인 경계]` 질문으로 사용자 결정을 받는다. 각 묶음·분리 대안과 권장 근거(요청의 목적에 맞는 가장 작은 안)를 보여 준다. 모든 질문은 [질문 형식](../grilling/GUIDE.md#ask-questions-the-user-can-answer)에 따라 확정된 범위와 지금 정해야 하는 이유(`context`), 대안마다 `effect`와 같은 업무 사례를 적용한 `example`을 갖는다. 한 가지 경계만 타당하거나 대안이 업무 책임을 바꾸지 않으면 묻지 않고 경계를 `요청 해석(에이전트 제안)`으로 기록한다. 분류(`core`·`supporting`·`generic`)도 같다: 근거가 둘 이상으로 갈려 결과가 달라질 때만 별도 `[서브도메인 분류]` 질문으로 묻고, 아니면 근거와 함께 `요청 해석(에이전트 제안)`으로 기록한다. 묻지 않고 정한 경계와 분류는 요구사항 승인 요청의 "묻지 않고 정한 것"에 올라가 사용자가 바꿀 수 있다. 분류 답변을 경계 승인으로 쓰지 않는다. 묶음에 따라 분류 대상이 달라지면 경계 답변을 받은 뒤 영향을 받은 분류만 확인한다. 질문이 남아 있으면 `action_required` / `USER_DECISION_REQUIRED`를 반환한다.
7. `requirements.md`의 SD 표에 분류·근거·`confirmed`를 적고, 경계 비교와 사용자가 승인한 묶음을 분류 근거와 구분해 기록한다. SD 표에는 출처 꼬리표를 붙이지 않는다. 경계와 분류 각각에 물었으면 `## 7. 출처 기록`의 `SD-xx` 행에 해당 `question_id`를, 묻지 않았으면 `요청 해석(에이전트 제안)`을 적는다. 이미 승인된 동일 경계는 그 근거를 유지한다. 이동한 `BIZ`의 제목과 SD 표의 `포함 업무`, `## 4`를 확정된 묶음에 맞춘다. 확정 문서를 수정했다면 문서는 `draft`로 두고 건드린 항목의 `출처·변경 이력`을 갱신한다.
8. When the set changed, rewrite the affected `SD-xx.events.puml` files and `cross-subdomain.events.puml` from the final tables, remove the diagrams of retired subdomains, render each with the local renderer as the [event diagram reference](../event-storming/references/diagrams.md) describes, and fix the links in `## 4`. A render failure blocks completion.
9. Check before returning: every `BIZ` belongs to exactly one subdomain, every subdomain is `confirmed` with a class and a sourced rationale, the `## 4` table and the diagrams match the final set, and no text of any `BIZ` changed. Return `completed/OK` with `requirements.md` and, when diagrams changed, the `diagrams/events` directory.

## Completion

- Every SD row has `분류` of `core`, `supporting` or `generic`, a `근거` and `상태: confirmed`; the set was confirmed by the user's answers or recorded as `요청 해석(에이전트 제안)` and listed for the approval.
- Any change to the set is backed by event evidence, and the diagrams and `## 4` agree with it.
- The runner commits `docs/specs/<plan-set-id>/` when this stage completes. `requirements-fix` and then `bounded-context` read the confirmed subdomains and their classes.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 기존 Subdomain의 분류와 근거를 확인한다. 기존 분류 변경은 사용자에게 확인한다.
